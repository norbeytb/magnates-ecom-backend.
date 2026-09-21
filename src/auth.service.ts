// auth.service.ts
//
// Sistema de cuentas: cada persona se registra con su correo + contraseña y
// entra con eso mismo. Sigue el mismo patrón de PostgreSQL (Railway) que
// historial.service.ts / landings.service.ts / productos.service.ts — si no
// hay DATABASE_URL configurada, el backend arranca igual pero nadie puede
// registrarse ni entrar (se avisa clarito en los logs).
//
// La contraseña NUNCA se guarda tal cual: se guarda su hash con bcrypt
// (imposible de revertir). Al iniciar sesión se compara el hash, no el texto.
//
// Quién es quién entre pedido y pedido se resuelve con un JWT (JSON Web
// Token): al registrarse o iniciar sesión, el backend firma un token con el
// id del usuario adentro (firmado con JWT_SECRET, una clave secreta que solo
// conoce este servidor) y se lo manda al taller. El taller lo guarda y lo
// manda de vuelta en cada pedido (header "Authorization: Bearer <token>"),
// así el backend sabe de quién son esos productos/landings/historial sin
// tener que volver a pedir la contraseña cada vez — ver auth.guard.ts.
//
// Dependencias que hay que instalar en el proyecto (no vienen con NestJS):
//   npm install bcryptjs jsonwebtoken
//   npm install -D @types/bcryptjs @types/jsonwebtoken
// (se usa "bcryptjs" — versión en JavaScript puro de bcrypt — en vez de
// "bcrypt" a secas, porque "bcrypt" necesita compilar código nativo en el
// build de Railway y puede fallar; "bcryptjs" hace exactamente lo mismo sin
// ese problema).
//
// "Olvidé mi contraseña" es MANUAL por ahora, no automático: no se manda
// ningún correo. Esto es a propósito — Railway (donde corre este backend)
// bloquea las conexiones SMTP salientes en los planes Free/Trial/Hobby (así
// que un envío directo, por ejemplo desde una cuenta de Gmail, no puede
// funcionar ahí), y los servicios de correo por HTTPS que sí funcionan en
// ese plan (como Resend) exigen verificar un dominio propio para poder
// mandarle el correo a cualquier persona — y verificar un dominio requiere
// tener uno comprado. Mientras eso no se resuelva, cuando alguien necesita
// recuperar el acceso escribe al soporte (correo o WhatsApp, ver el botón
// "¿Olvidaste tu contraseña?" del taller) y un administrador le cambia la
// contraseña a mano desde el panel de administración — ver
// listarUsuarios/restablecerPasswordAdmin más abajo y admin.controller.ts.
//
// Variables de entorno nuevas que hay que agregar en Railway:
//   JWT_SECRET    — cualquier texto largo y aleatorio (ej. generado con
//                    `openssl rand -hex 32`). Si no está configurada, el
//                    backend arranca igual pero avisa en los logs y usa una
//                    clave de emergencia solo para no romper — hay que
//                    configurar la de verdad antes de usar esto en serio,
//                    porque sin ella cualquiera podría fabricarse un token.
//   ADMIN_EMAILS  — uno o más correos separados por coma (ej.
//                    "vos@gmail.com,otro@gmail.com") que van a poder entrar
//                    al panel de administración (ver todos los usuarios y
//                    cambiarles la contraseña a mano). Sin esto configurado,
//                    nadie tiene acceso de administrador, ni siquiera vos.
//   SSO_SHARED_SECRET — texto largo y aleatorio, el MISMO valor que se pone
//                    del lado de MEC Control (variable de entorno ahí con
//                    el mismo nombre). Es lo que le permite a MEC Control
//                    pedir un "pase" de inicio de sesión único para uno de
//                    sus usuarios — ver generarPaseSso()/entrarConPase() más
//                    abajo. Sin esta variable configurada, ese camino queda
//                    cerrado del todo (no hay clave de emergencia acá: a
//                    diferencia de JWT_SECRET, dejar esto abierto sin
//                    querer significaría que cualquiera podría loguearse
//                    como cualquier correo).

import { ConflictException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

export interface UsuarioPublico {
  id: number;
  email: string;
  nombre?: string;
  apellido?: string;
  // Ver la nota de ADMIN_EMAILS más arriba — se recalcula en cada pedido
  // (nunca se confía en lo que diga un token viejo), así que cambiar esa
  // variable en Railway aplica al toque, sin que nadie tenga que volver a
  // iniciar sesión.
  esAdmin: boolean;
}

// Fila que devuelve listarUsuarios() para el panel de administración — no
// incluye password_hash ni nada sensible, solo lo que hace falta para
// mostrar la lista y saber a quién restablecerle la contraseña.
export interface UsuarioParaAdmin {
  id: number;
  email: string;
  nombre?: string;
  apellido?: string;
  creadoEn: string;
  // Ver bloquearUsuario()/verificarNoBloqueado() más abajo — si está en
  // true, esta cuenta no puede iniciar sesión ni usar el taller (aunque ya
  // tenga una sesión abierta) hasta que un administrador la desbloquee.
  bloqueado: boolean;
}

export interface SesionResultado extends UsuarioPublico {
  token: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private pool: Pool | null = null;

  // Clave para firmar los tokens. Usa JWT_SECRET si está configurada — si no,
  // cae en una clave fija SOLO para que el backend no se caiga sin base de
  // datos configurada; con la clave de emergencia, cualquiera que lea este
  // código podría fabricar tokens válidos, así que en Railway hay que poner
  // JWT_SECRET de verdad antes de usar esto con usuarios reales.
  private get jwtSecret(): string {
    if (!process.env.JWT_SECRET) {
      this.logger.warn('JWT_SECRET no está configurada — usando una clave de emergencia insegura. Configurá JWT_SECRET en Railway antes de usar esto en serio.');
      return 'ecom-magnates-clave-de-emergencia-insegura-configurar-JWT_SECRET';
    }
    return process.env.JWT_SECRET;
  }

  private configurado(): boolean {
    return !!process.env.DATABASE_URL;
  }

  // Lista de correos con acceso de administrador — ver la nota de
  // ADMIN_EMAILS arriba del todo del archivo.
  private get adminEmails(): string[] {
    return String(process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((correo) => correo.trim().toLowerCase())
      .filter(Boolean);
  }

  private esAdminEmail(email: string): boolean {
    return this.adminEmails.includes(this.normalizarEmail(email));
  }

  // Compara el secreto que mandó MEC Control contra SSO_SHARED_SECRET en
  // tiempo constante (crypto.timingSafeEqual) — comparar con "===" filtraría
  // de a poquito, por cuánto tarda la comparación, cuántos caracteres
  // acertó quien intenta adivinar el secreto. Sin la variable configurada,
  // esto SIEMPRE rechaza (a propósito: ver la nota de SSO_SHARED_SECRET
  // arriba del todo del archivo).
  private compararSecretoSso(recibido: string): boolean {
    const esperado = process.env.SSO_SHARED_SECRET;
    if (!esperado) {
      this.logger.warn('SSO_SHARED_SECRET no está configurada — se rechaza cualquier pedido de inicio de sesión único hasta que se configure.');
      return false;
    }
    const bufEsperado = Buffer.from(esperado);
    const bufRecibido = Buffer.from(String(recibido || ''));
    // timingSafeEqual exige el mismo largo en los dos buffers, si no explota
    // — con longitudes distintas ya sabemos que no coinciden.
    if (bufEsperado.length !== bufRecibido.length) return false;
    return crypto.timingSafeEqual(bufEsperado, bufRecibido);
  }

  async onModuleInit() {
    if (!this.configurado()) {
      this.logger.warn('DATABASE_URL no está configurada — el registro/inicio de sesión no va a funcionar.');
      return;
    }
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS usuarios (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // Nombre y apellido son opcionales (el formulario del taller los pide
      // al registrarse, pero cuentas creadas antes de este cambio no los
      // tienen) — se usan solo para mostrar un saludo más lindo que el
      // correo pelado en la esquina del taller.
      await this.pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nombre TEXT;`);
      await this.pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS apellido TEXT;`);
      // Bloqueo de acceso manual desde el panel de administración — ver
      // bloquearUsuario()/verificarNoBloqueado() más abajo. DEFAULT false para
      // que las cuentas existentes (y las nuevas) arranquen sin bloquear.
      await this.pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado BOOLEAN NOT NULL DEFAULT false;`);
      this.logger.log('Conectado a PostgreSQL — tabla "usuarios" lista.');
    } catch (error) {
      this.logger.error('No se pudo conectar/crear la tabla de usuarios: ' + (error as Error).message);
      this.pool = null;
    }
  }

  private normalizarEmail(email: string): string {
    return String(email || '').trim().toLowerCase();
  }

  private firmarToken(usuario: UsuarioPublico): string {
    // Vence a los 30 días — bastante largo para no molestar pidiendo que
    // vuelva a entrar todo el tiempo, pero no "para siempre". Nombre/apellido
    // van adentro del token (no solo en la respuesta del login) para que
    // GET /auth/me — lo que valida la sesión guardada al recargar la página —
    // también los pueda devolver sin tener que ir a buscarlos de nuevo a la base.
    return jwt.sign(
      { sub: usuario.id, email: usuario.email, nombre: usuario.nombre || undefined, apellido: usuario.apellido || undefined },
      this.jwtSecret,
      { expiresIn: '30d' },
    );
  }

  async registrar(email: string, password: string, nombre?: string, apellido?: string): Promise<SesionResultado> {
    if (!this.pool) {
      throw new InternalServerErrorException('El registro no está disponible: falta configurar la base de datos en el backend.');
    }
    const emailNormalizado = this.normalizarEmail(email);
    if (!emailNormalizado || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
      throw new ConflictException('Ese correo no parece válido.');
    }
    if (!password || String(password).length < 8) {
      throw new ConflictException('La contraseña debe tener al menos 8 caracteres.');
    }
    const nombreLimpio = String(nombre || '').trim() || null;
    const apellidoLimpio = String(apellido || '').trim() || null;

    const existente = await this.pool.query(`SELECT id FROM usuarios WHERE email = $1`, [emailNormalizado]);
    if ((existente.rowCount ?? 0) > 0) {
      throw new ConflictException('Ya existe una cuenta con ese correo. Iniciá sesión en vez de registrarte.');
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const resultado = await this.pool.query(
      `INSERT INTO usuarios (email, password_hash, nombre, apellido) VALUES ($1, $2, $3, $4) RETURNING id, email, nombre, apellido`,
      [emailNormalizado, passwordHash, nombreLimpio, apellidoLimpio],
    );
    const fila = resultado.rows[0];
    const usuario: UsuarioPublico = { id: fila.id, email: fila.email, nombre: fila.nombre || undefined, apellido: fila.apellido || undefined, esAdmin: this.esAdminEmail(fila.email) };
    this.logger.log(`Nueva cuenta registrada: ${usuario.email}`);
    return { ...usuario, token: this.firmarToken(usuario) };
  }

  async login(email: string, password: string): Promise<SesionResultado> {
    if (!this.pool) {
      throw new InternalServerErrorException('El inicio de sesión no está disponible: falta configurar la base de datos en el backend.');
    }
    const emailNormalizado = this.normalizarEmail(email);
    const resultado = await this.pool.query(
      `SELECT id, email, password_hash, nombre, apellido, bloqueado FROM usuarios WHERE email = $1`,
      [emailNormalizado],
    );
    const fila = resultado.rows[0];
    // Mismo mensaje genérico tanto si el correo no existe como si la
    // contraseña está mal — así no se le confirma a quien intente adivinar
    // si un correo específico ya está registrado.
    if (!fila || !(await bcrypt.compare(String(password || ''), fila.password_hash))) {
      throw new UnauthorizedException('Correo o contraseña incorrectos.');
    }
    // El chequeo de bloqueo va DESPUÉS de validar la contraseña (no antes) —
    // así alguien que solo esté adivinando contraseñas nunca se entera, con
    // este mensaje distinto, de que un correo puntual existe y está
    // bloqueado; solo lo ve quien realmente conoce la contraseña correcta.
    if (fila.bloqueado) {
      throw new ForbiddenException('Tu cuenta fue bloqueada. Escribinos a soporte si creés que es un error.');
    }
    const usuario: UsuarioPublico = { id: fila.id, email: fila.email, nombre: fila.nombre || undefined, apellido: fila.apellido || undefined, esAdmin: this.esAdminEmail(fila.email) };
    return { ...usuario, token: this.firmarToken(usuario) };
  }

  // ---------------- INICIO DE SESIÓN ÚNICO (SSO) CON MEC CONTROL ----------------
  // Dos pasos, dos endpoints (ver auth.controller.ts), pensados para que el
  // secreto compartido NUNCA pase por el navegador del estudiante:
  //
  //   1. generarPaseSso(): lo llama el SERVIDOR de MEC Control (nunca un
  //      navegador) con el correo del usuario logueado ahí + el secreto
  //      compartido. Devuelve un "pase" (un JWT que vence en apenas 60
  //      segundos) — tan corto a propósito, porque solo tiene que sobrevivir
  //      el viaje de "MEC Control lo pide" a "el navegador lo canjea",
  //      nada más.
  //
  //   2. entrarConPase(): lo llama el NAVEGADOR del estudiante (el taller ya
  //      trae este código, ver "?pase=" en taller-generador-landing.html),
  //      con el pase que acaba de recibir en la URL. Lo canjea por una
  //      sesión normal de 30 días, igual que un login de toda la vida.

  async generarPaseSso(email: string, secretoRecibido: string): Promise<{ pase: string }> {
    if (!this.pool) {
      throw new InternalServerErrorException('El inicio de sesión único no está disponible: falta configurar la base de datos en el backend.');
    }
    if (!this.compararSecretoSso(secretoRecibido)) {
      throw new UnauthorizedException('Secreto de inicio de sesión único inválido.');
    }
    const emailNormalizado = this.normalizarEmail(email);
    if (!emailNormalizado || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
      throw new ConflictException('Ese correo no parece válido.');
    }

    let fila = (
      await this.pool.query(
        `SELECT id, email, nombre, apellido, bloqueado FROM usuarios WHERE email = $1`,
        [emailNormalizado],
      )
    ).rows[0];

    if (!fila) {
      // Cuenta nueva e independiente, con una contraseña aleatoria que nadie
      // necesita conocer — por este camino nunca se entra escribiendo una
      // contraseña, solo con el pase. Si alguna vez esa persona quisiera
      // entrar acá directo (sin pasar por MEC Control), tendría que usar
      // "¿Olvidaste tu contraseña?" (manual, ver la nota grande arriba del
      // archivo) para ponerle una.
      const passwordAleatoria = crypto.randomBytes(24).toString('hex');
      const passwordHash = await bcrypt.hash(passwordAleatoria, 10);
      fila = (
        await this.pool.query(
          `INSERT INTO usuarios (email, password_hash) VALUES ($1, $2) RETURNING id, email, nombre, apellido, bloqueado`,
          [emailNormalizado, passwordHash],
        )
      ).rows[0];
      this.logger.log(`Cuenta creada automáticamente por inicio de sesión único (MEC Control): ${fila.email} (id=${fila.id}).`);
    }

    if (fila.bloqueado) {
      throw new ForbiddenException('Esta cuenta fue bloqueada. Escribinos a soporte si creés que es un error.');
    }

    // "tipo: pase_sso" es lo que distingue este token de uno normal de 30
    // días — entrarConPase() de abajo lo exige para no aceptar por error un
    // token de sesión común como si fuera un pase.
    const pase = jwt.sign(
      { sub: fila.id, email: fila.email, tipo: 'pase_sso' },
      this.jwtSecret,
      { expiresIn: '60s' },
    );
    return { pase };
  }

  async entrarConPase(pase: string): Promise<SesionResultado> {
    if (!this.pool) {
      throw new InternalServerErrorException('El inicio de sesión único no está disponible: falta configurar la base de datos en el backend.');
    }
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(String(pase || ''), this.jwtSecret) as jwt.JwtPayload;
    } catch {
      throw new UnauthorizedException('Pase inválido o vencido — volvé a entrar desde MEC Control.');
    }
    // Sin este chequeo, un token normal de 30 días (reenviado por error, o
    // robado) también pasaría jwt.verify() y quedaría canjeado acá como si
    // fuera un pase — exigir "tipo: pase_sso" cierra esa puerta.
    if (payload.tipo !== 'pase_sso') {
      throw new UnauthorizedException('Ese enlace no es un pase de inicio de sesión único válido.');
    }
    const resultado = await this.pool.query(
      `SELECT id, email, nombre, apellido, bloqueado FROM usuarios WHERE id = $1`,
      [Number(payload.sub)],
    );
    const fila = resultado.rows[0];
    if (!fila) {
      throw new NotFoundException('La cuenta de este pase ya no existe.');
    }
    if (fila.bloqueado) {
      throw new ForbiddenException('Esta cuenta fue bloqueada. Escribinos a soporte si creés que es un error.');
    }
    const usuario: UsuarioPublico = { id: fila.id, email: fila.email, nombre: fila.nombre || undefined, apellido: fila.apellido || undefined, esAdmin: this.esAdminEmail(fila.email) };
    this.logger.log(`Inicio de sesión único (MEC Control) para ${usuario.email} (id=${usuario.id}).`);
    return { ...usuario, token: this.firmarToken(usuario) };
  }

  // ---------------- PANEL DE ADMINISTRACIÓN ----------------
  // Ver la nota grande arriba del todo del archivo: mientras no haya un
  // dominio propio verificado para mandar correos, "olvidé mi contraseña" es
  // manual — el administrador (cualquier correo en ADMIN_EMAILS) usa estos
  // dos métodos desde admin.controller.ts para ver quién está registrado y
  // cambiarle la contraseña a mano cuando alguien lo pida por fuera del
  // sistema (correo o WhatsApp de soporte).

  async listarUsuarios(): Promise<UsuarioParaAdmin[]> {
    if (!this.pool) return [];
    const resultado = await this.pool.query(
      `SELECT id, email, nombre, apellido, creado_en, bloqueado FROM usuarios ORDER BY creado_en DESC`,
    );
    return resultado.rows.map((fila) => ({
      id: fila.id,
      email: fila.email,
      nombre: fila.nombre || undefined,
      apellido: fila.apellido || undefined,
      creadoEn: fila.creado_en,
      bloqueado: !!fila.bloqueado,
    }));
  }

  // Bloquea o desbloquea el acceso de una cuenta a mano desde el panel de
  // administración — por ejemplo si un estudiante dejó de pagar el curso, o
  // hay que cortarle el acceso por cualquier otro motivo. No se puede
  // bloquear una cuenta de administrador (evita que alguien se bloquee sin
  // querer a sí mismo, o a otro administrador, y se quede sin poder entrar a
  // desbloquearse).
  async bloquearUsuario(usuarioId: number, bloqueado: boolean): Promise<{ ok: true; bloqueado: boolean }> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo actualizar el acceso: falta configurar la base de datos en el backend.');
    }
    const resultado = await this.pool.query(`SELECT id, email FROM usuarios WHERE id = $1`, [usuarioId]);
    const fila = resultado.rows[0];
    if (!fila) {
      throw new NotFoundException('No existe ningún usuario con ese id.');
    }
    if (bloqueado && this.esAdminEmail(fila.email)) {
      throw new ConflictException('No podés bloquear una cuenta de administrador.');
    }
    await this.pool.query(`UPDATE usuarios SET bloqueado = $1 WHERE id = $2`, [bloqueado, usuarioId]);
    this.logger.log(`Un administrador ${bloqueado ? 'bloqueó' : 'desbloqueó'} la cuenta ${fila.email} (id=${fila.id}).`);
    return { ok: true, bloqueado };
  }

  // Pedido 09/09: agrega el botón "Eliminar" al panel de administración —
  // a diferencia de bloquearUsuario() (que solo corta el acceso pero deja
  // todo intacto por si hay que revertirlo), esto borra la cuenta para
  // siempre. Es IRREVERSIBLE: no hay una tabla de "usuarios eliminados" ni
  // manera de deshacerlo — el frontend ya pide confirmación explícita antes
  // de llamar a este método, pero igual queda documentado acá.
  //
  // Qué se borra y qué NO: se borra la fila de "usuarios" y su fila en
  // "integraciones" (ahí vive su clave de fal.ai y sus credenciales de
  // Shopify — no tiene sentido dejarlas guardadas para una cuenta que ya no
  // existe). El resto de sus datos (historial de piezas generadas, landings
  // ensambladas, productos, plantillas guardadas) NO se borra — quedan en la
  // base de datos con su usuario_id apuntando a una cuenta que ya no existe,
  // exactamente el mismo caso que ya maneja el sistema para datos viejos de
  // ANTES de que existieran las cuentas (usuario_id NULL, ver nota arriba de
  // historial.service.ts/landings.service.ts/productos.service.ts): esas
  // filas no le aparecen a nadie más (cada consulta ya filtra por
  // usuario_id), así que quedan simplemente huérfanas e invisibles, sin
  // riesgo de que otra persona las vea ni de romper ninguna otra tabla (ninguna
  // de esas tablas tiene una restricción de llave foránea hacia "usuarios").
  // No se borran de una para no complicar esto con años de tablas distintas
  // por un caso que además no expone nada sensible (a diferencia de las
  // claves de integraciones, que sí se borran arriba).
  async eliminarUsuario(usuarioId: number): Promise<{ ok: true }> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo eliminar la cuenta: falta configurar la base de datos en el backend.');
    }
    const resultado = await this.pool.query(`SELECT id, email FROM usuarios WHERE id = $1`, [usuarioId]);
    const fila = resultado.rows[0];
    if (!fila) {
      throw new NotFoundException('No existe ningún usuario con ese id.');
    }
    if (this.esAdminEmail(fila.email)) {
      throw new ConflictException('No podés eliminar una cuenta de administrador.');
    }
    await this.pool.query(`DELETE FROM integraciones WHERE usuario_id = $1`, [usuarioId]);
    await this.pool.query(`DELETE FROM usuarios WHERE id = $1`, [usuarioId]);
    this.logger.log(`Un administrador eliminó la cuenta ${fila.email} (id=${fila.id}).`);
    return { ok: true };
  }

  async restablecerPasswordAdmin(usuarioId: number, password: string): Promise<{ ok: true }> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo restablecer la contraseña: falta configurar la base de datos en el backend.');
    }
    if (!password || String(password).length < 8) {
      throw new ConflictException('La contraseña debe tener al menos 8 caracteres.');
    }
    const passwordHash = await bcrypt.hash(String(password), 10);
    const resultado = await this.pool.query(
      `UPDATE usuarios SET password_hash = $1 WHERE id = $2 RETURNING id, email`,
      [passwordHash, usuarioId],
    );
    const fila = resultado.rows[0];
    if (!fila) {
      throw new NotFoundException('No existe ningún usuario con ese id.');
    }
    this.logger.log(`Un administrador restableció la contraseña de ${fila.email} (id=${fila.id}).`);
    return { ok: true };
  }

  // ---------------- MI PERFIL (cada usuario sobre su propia cuenta) ----------------
  // A diferencia de restablecerPasswordAdmin() de arriba (que usa un
  // administrador para cambiarle la contraseña a CUALQUIERA sin saber la
  // vieja), acá cada persona edita SU PROPIA cuenta — actualizarPerfil() no
  // pide contraseña porque solo toca nombre/apellido/correo, pero
  // cambiarPasswordPropia() sí exige la contraseña actual antes de aceptar
  // la nueva, como cualquier "cambiar contraseña" normal.

  async actualizarPerfil(usuarioId: number, datos: { nombre?: string; apellido?: string; email?: string }): Promise<SesionResultado> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo actualizar el perfil: falta configurar la base de datos en el backend.');
    }
    const nombre = datos.nombre !== undefined ? String(datos.nombre).trim() : undefined;
    const apellido = datos.apellido !== undefined ? String(datos.apellido).trim() : undefined;
    const email = datos.email !== undefined ? this.normalizarEmail(datos.email) : undefined;

    if (email !== undefined && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      throw new ConflictException('Ingresá un correo válido.');
    }

    // Arma el UPDATE solo con las columnas que realmente vinieron en el
    // pedido — así el taller puede mandar nombre/apellido/correo juntos (como
    // hace ahora, con un solo formulario) sin que un campo vacío borre sin
    // querer los otros dos.
    const columnas: string[] = [];
    const valores: any[] = [];
    let i = 1;
    if (nombre !== undefined) { columnas.push(`nombre = $${i++}`); valores.push(nombre || null); }
    if (apellido !== undefined) { columnas.push(`apellido = $${i++}`); valores.push(apellido || null); }
    if (email !== undefined) { columnas.push(`email = $${i++}`); valores.push(email); }
    if (columnas.length === 0) {
      throw new ConflictException('No hay ningún cambio para guardar.');
    }
    valores.push(usuarioId);

    let resultado;
    try {
      resultado = await this.pool.query(
        `UPDATE usuarios SET ${columnas.join(', ')} WHERE id = $${i} RETURNING id, email, nombre, apellido`,
        valores,
      );
    } catch (error: any) {
      // 23505 = unique_violation — el correo nuevo ya lo está usando otra cuenta.
      if (error?.code === '23505') {
        throw new ConflictException('Ese correo ya está siendo usado por otra cuenta.');
      }
      throw error;
    }
    const fila = resultado.rows[0];
    if (!fila) {
      throw new NotFoundException('No existe esa cuenta.');
    }
    const usuario: UsuarioPublico = { id: fila.id, email: fila.email, nombre: fila.nombre || undefined, apellido: fila.apellido || undefined, esAdmin: this.esAdminEmail(fila.email) };
    this.logger.log(`Perfil actualizado: ${usuario.email} (id=${usuario.id}).`);
    // Devuelve un token NUEVO — el correo/nombre pudieron haber cambiado, y
    // esos datos van adentro del token (ver firmarToken) — así el taller no
    // se queda mostrando la sesión con los datos viejos hasta que alguien
    // vuelva a iniciar sesión.
    return { ...usuario, token: this.firmarToken(usuario) };
  }

  async cambiarPasswordPropia(usuarioId: number, passwordActual: string, passwordNueva: string): Promise<{ ok: true }> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo cambiar la contraseña: falta configurar la base de datos en el backend.');
    }
    if (!passwordNueva || String(passwordNueva).length < 8) {
      throw new ConflictException('La contraseña nueva debe tener al menos 8 caracteres.');
    }
    const resultado = await this.pool.query(`SELECT id, password_hash FROM usuarios WHERE id = $1`, [usuarioId]);
    const fila = resultado.rows[0];
    if (!fila) {
      throw new NotFoundException('No existe esa cuenta.');
    }
    if (!(await bcrypt.compare(String(passwordActual || ''), fila.password_hash))) {
      throw new UnauthorizedException('La contraseña actual no es correcta.');
    }
    const nuevoHash = await bcrypt.hash(String(passwordNueva), 10);
    await this.pool.query(`UPDATE usuarios SET password_hash = $1 WHERE id = $2`, [nuevoHash, usuarioId]);
    this.logger.log(`La cuenta id=${usuarioId} cambió su propia contraseña.`);
    return { ok: true };
  }
}
