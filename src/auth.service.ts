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

import { ConflictException, ForbiddenException, Injectable, InternalServerErrorException, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

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
      `SELECT id, email, password_hash, nombre, apellido FROM usuarios WHERE email = $1`,
      [emailNormalizado],
    );
    const fila = resultado.rows[0];
    // Mismo mensaje genérico tanto si el correo no existe como si la
    // contraseña está mal — así no se le confirma a quien intente adivinar
    // si un correo específico ya está registrado.
    if (!fila || !(await bcrypt.compare(String(password || ''), fila.password_hash))) {
      throw new UnauthorizedException('Correo o contraseña incorrectos.');
    }
    const usuario: UsuarioPublico = { id: fila.id, email: fila.email, nombre: fila.nombre || undefined, apellido: fila.apellido || undefined, esAdmin: this.esAdminEmail(fila.email) };
    return { ...usuario, token: this.firmarToken(usuario) };
  }

  // Usado por AuthGuard en cada pedido protegido: valida la firma del token
  // (y que no haya vencido) y devuelve quién es. Si el token es inválido o
  // vencido, lanza UnauthorizedException.
  verificarToken(token: string): UsuarioPublico {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as jwt.JwtPayload;
      const email = String(payload.email || '');
      return {
        id: Number(payload.sub),
        email,
        nombre: payload.nombre ? String(payload.nombre) : undefined,
        apellido: payload.apellido ? String(payload.apellido) : undefined,
        // A propósito NO se lee de payload: se recalcula siempre contra el
        // ADMIN_EMAILS actual (ver la nota arriba del todo del archivo), así
        // un token viejo nunca puede seguir dando acceso de administrador
        // después de que se lo saque de esa variable en Railway.
        esAdmin: this.esAdminEmail(email),
      };
    } catch {
      throw new UnauthorizedException('Sesión inválida o vencida — volvé a iniciar sesión.');
    }
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
      `SELECT id, email, nombre, apellido, creado_en FROM usuarios ORDER BY creado_en DESC`,
    );
    return resultado.rows.map((fila) => ({
      id: fila.id,
      email: fila.email,
      nombre: fila.nombre || undefined,
      apellido: fila.apellido || undefined,
      creadoEn: fila.creado_en,
    }));
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
