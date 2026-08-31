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
//   npm install bcryptjs jsonwebtoken nodemailer
//   npm install -D @types/bcryptjs @types/jsonwebtoken @types/nodemailer
// (se usa "bcryptjs" — versión en JavaScript puro de bcrypt — en vez de
// "bcrypt" a secas, porque "bcrypt" necesita compilar código nativo en el
// build de Railway y puede fallar; "bcryptjs" hace exactamente lo mismo sin
// ese problema).
//
// El correo de "olvidé mi contraseña" se manda con "nodemailer" a través del
// SMTP de Gmail, usando una cuenta de Gmail común (no un servicio de correo
// transaccional tipo Resend/SendGrid) — así no hace falta comprar ni
// verificar un dominio propio para poder mandarle el correo a cualquier
// persona, solo una cuenta de Gmail con una "contraseña de aplicación". Ver
// la nota completa en enviarCorreoRecuperacion más abajo.
//
// Variables de entorno nuevas que hay que agregar en Railway:
//   JWT_SECRET         — cualquier texto largo y aleatorio (ej. generado con
//                         `openssl rand -hex 32`). Si no está configurada, el
//                         backend arranca igual pero avisa en los logs y usa
//                         una clave de emergencia solo para no romper — hay
//                         que configurar la de verdad antes de usar esto en
//                         serio, porque sin ella cualquiera podría fabricarse
//                         un token.
//   GMAIL_USER         — la dirección de Gmail desde la que se manda el
//                         correo de recuperación (ej. "tucorreo@gmail.com").
//                         Sin esto, "olvidé mi contraseña" no manda nada —
//                         solo se avisa en los logs.
//   GMAIL_APP_PASSWORD — la "contraseña de aplicación" de esa cuenta de
//                         Gmail (NO la contraseña normal de la cuenta) — se
//                         genera en myaccount.google.com → Seguridad →
//                         Verificación en dos pasos → Contraseñas de
//                         aplicaciones. Hace falta tener activada la
//                         verificación en dos pasos en esa cuenta de Google
//                         para poder generarla.
//   PUBLIC_APP_URL     — la URL pública donde se abre el taller (ej.
//                         "https://tu-taller.ejemplo.com/"), para poder
//                         armar el link de recuperación que va dentro del
//                         correo. Sin esto, el link no va a apuntar a ningún
//                         lado real.

import { ConflictException, Injectable, InternalServerErrorException, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';

export interface UsuarioPublico {
  id: number;
  email: string;
  nombre?: string;
  apellido?: string;
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

  // Cuenta de Gmail desde la que se manda el correo de "recuperar
  // contraseña". Si falta cualquiera de las dos variables, no se rompe nada
  // — simplemente no se manda el correo y se avisa en los logs (así el
  // resto del backend sigue funcionando aunque todavía no se haya
  // configurado esto).
  private get gmailUser(): string | null {
    return process.env.GMAIL_USER || null;
  }

  private get gmailAppPassword(): string | null {
    return process.env.GMAIL_APP_PASSWORD || null;
  }

  private get publicAppUrl(): string | null {
    return process.env.PUBLIC_APP_URL || null;
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
      // Para "olvidé mi contraseña": un token de un solo uso, guardado con su
      // fecha de vencimiento. Mientras no se pida una recuperación quedan en
      // NULL.
      await this.pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT;`);
      await this.pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expira TIMESTAMPTZ;`);
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
    const usuario: UsuarioPublico = { id: fila.id, email: fila.email, nombre: fila.nombre || undefined, apellido: fila.apellido || undefined };
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
    const usuario: UsuarioPublico = { id: fila.id, email: fila.email, nombre: fila.nombre || undefined, apellido: fila.apellido || undefined };
    return { ...usuario, token: this.firmarToken(usuario) };
  }

  // Usado por AuthGuard en cada pedido protegido: valida la firma del token
  // (y que no haya vencido) y devuelve quién es. Si el token es inválido o
  // vencido, lanza UnauthorizedException.
  verificarToken(token: string): UsuarioPublico {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as jwt.JwtPayload;
      return {
        id: Number(payload.sub),
        email: String(payload.email || ''),
        nombre: payload.nombre ? String(payload.nombre) : undefined,
        apellido: payload.apellido ? String(payload.apellido) : undefined,
      };
    } catch {
      throw new UnauthorizedException('Sesión inválida o vencida — volvé a iniciar sesión.');
    }
  }

  // Cachea el "transporter" de nodemailer (la conexión configurada al SMTP
  // de Gmail) — no hace falta armarlo de nuevo en cada correo, solo la
  // primera vez que hace falta mandar uno.
  private transportadorGmail: nodemailer.Transporter | null = null;

  private obtenerTransportadorGmail(): nodemailer.Transporter | null {
    const user = this.gmailUser;
    const pass = this.gmailAppPassword;
    if (!user || !pass) return null;
    if (!this.transportadorGmail) {
      this.transportadorGmail = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
        // Sin esto, si Gmail no contesta (red bloqueada, credenciales mal,
        // etc.) la conexión puede quedarse colgada varios minutos — con
        // estos límites, a los 15 segundos se da por vencida y tira error en
        // vez de quedarse esperando para siempre.
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000,
      });
    }
    return this.transportadorGmail;
  }

  // Manda el correo de recuperación con el link para elegir una contraseña
  // nueva, usando el SMTP de Gmail (con una cuenta de Gmail común y una
  // "contraseña de aplicación" — no un servicio de correo transaccional como
  // Resend/SendGrid). Se eligió así para no depender de comprar y verificar
  // un dominio propio: con una cuenta de Gmail y su contraseña de aplicación
  // alcanza para mandarle este correo a cualquier persona, gratis. El límite
  // es de aproximadamente 100-150 correos por día por cuenta de Gmail — de
  // sobra para esto. Si falta configurar GMAIL_USER/GMAIL_APP_PASSWORD, no
  // revienta — solo avisa en los logs, para que el resto del sistema
  // (registro, login) siga funcionando igual.
  private async enviarCorreoRecuperacion(email: string, nombre: string | null, token: string): Promise<void> {
    const transportador = this.obtenerTransportadorGmail();
    if (!transportador) {
      this.logger.warn(`No se pudo mandar el correo de recuperación a ${email}: falta configurar GMAIL_USER y GMAIL_APP_PASSWORD en Railway.`);
      return;
    }
    const baseUrl = this.publicAppUrl;
    if (!baseUrl) {
      this.logger.warn(`No se pudo armar el link de recuperación para ${email}: falta configurar PUBLIC_APP_URL en Railway.`);
      return;
    }
    const separador = baseUrl.includes('?') ? '&' : '?';
    const link = `${baseUrl}${separador}resetToken=${encodeURIComponent(token)}`;
    const saludo = nombre ? `Hola, ${nombre}:` : 'Hola:';
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#1c1810;">Recuperar contraseña</h2>
        <p>${saludo}</p>
        <p>Pediste recuperar el acceso a tu cuenta de Ecom Magnates. Hacé clic en el siguiente botón para elegir una contraseña nueva:</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${link}" style="background:#d4a935;color:#1c1408;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Elegir nueva contraseña</a>
        </p>
        <p>Si el botón no funciona, copiá y pegá este link en tu navegador:<br>${link}</p>
        <p>Este link vence en 1 hora. Si vos no pediste esto, podés ignorar este correo — tu contraseña sigue igual.</p>
      </div>
    `;
    try {
      await transportador.sendMail({
        from: `"Ecom Magnates" <${this.gmailUser}>`,
        to: email,
        subject: 'Recuperar tu contraseña — Ecom Magnates',
        html,
      });
    } catch (error) {
      this.logger.error('No se pudo mandar el correo de recuperación: ' + (error as Error).message);
    }
  }

  // Siempre devuelve { ok: true } exista o no esa cuenta — así nadie puede
  // usar este endpoint para averiguar qué correos están registrados. Si el
  // correo existe de verdad, por atrás se genera un token y se manda el
  // correo con el link.
  async solicitarRecuperacion(email: string): Promise<{ ok: true }> {
    if (!this.pool) {
      return { ok: true };
    }
    const emailNormalizado = this.normalizarEmail(email);
    if (!emailNormalizado) {
      return { ok: true };
    }
    const resultado = await this.pool.query(`SELECT id, email, nombre FROM usuarios WHERE email = $1`, [emailNormalizado]);
    const fila = resultado.rows[0];
    if (fila) {
      const token = crypto.randomBytes(32).toString('hex');
      const expira = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
      await this.pool.query(`UPDATE usuarios SET reset_token = $1, reset_token_expira = $2 WHERE id = $3`, [token, expira, fila.id]);
      // OJO: a propósito NO se espera ("await") a que termine de mandarse el
      // correo antes de responder — así el pedido HTTP le contesta al taller
      // al toque, sin importar cuánto tarde (o si se cuelga) la conexión
      // SMTP a Gmail. Antes esto sí se esperaba, y si Gmail no respondía
      // rápido, la persona se quedaba viendo "Enviando…" en el botón para
      // siempre, sin ningún aviso.
      this.enviarCorreoRecuperacion(fila.email, fila.nombre || null, token).catch((error) => {
        this.logger.error('Fallo al mandar el correo de recuperación (en segundo plano): ' + (error as Error).message);
      });
      this.logger.log(`Recuperación de contraseña solicitada para ${fila.email}`);
    }
    return { ok: true };
  }

  async restablecerPassword(token: string, password: string): Promise<{ ok: true }> {
    if (!this.pool) {
      throw new InternalServerErrorException('No se pudo restablecer la contraseña: falta configurar la base de datos en el backend.');
    }
    const tokenLimpio = String(token || '').trim();
    if (!tokenLimpio) {
      throw new UnauthorizedException('El link de recuperación no es válido — pedí uno nuevo.');
    }
    if (!password || String(password).length < 8) {
      throw new ConflictException('La contraseña debe tener al menos 8 caracteres.');
    }
    const resultado = await this.pool.query(
      `SELECT id, reset_token_expira FROM usuarios WHERE reset_token = $1`,
      [tokenLimpio],
    );
    const fila = resultado.rows[0];
    if (!fila || !fila.reset_token_expira || new Date(fila.reset_token_expira).getTime() < Date.now()) {
      throw new UnauthorizedException('El link de recuperación no es válido o ya venció — pedí uno nuevo.');
    }
    const passwordHash = await bcrypt.hash(String(password), 10);
    await this.pool.query(
      `UPDATE usuarios SET password_hash = $1, reset_token = NULL, reset_token_expira = NULL WHERE id = $2`,
      [passwordHash, fila.id],
    );
    this.logger.log(`Contraseña restablecida para el usuario id=${fila.id}`);
    return { ok: true };
  }
}
