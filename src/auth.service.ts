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
// Variable de entorno nueva que hay que agregar en Railway:
//   JWT_SECRET  — cualquier texto largo y aleatorio (ej. generado con
//                 `openssl rand -hex 32`). Si no está configurada, el
//                 backend arranca igual pero avisa en los logs y usa una
//                 clave de emergencia solo para no romper — hay que
//                 configurar la de verdad antes de usar esto en serio,
//                 porque sin ella cualquiera podría fabricarse un token.

import { ConflictException, Injectable, InternalServerErrorException, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';

export interface UsuarioPublico {
  id: number;
  email: string;
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
    // vuelva a entrar todo el tiempo, pero no "para siempre".
    return jwt.sign({ sub: usuario.id, email: usuario.email }, this.jwtSecret, { expiresIn: '30d' });
  }

  async registrar(email: string, password: string): Promise<SesionResultado> {
    if (!this.pool) {
      throw new InternalServerErrorException('El registro no está disponible: falta configurar la base de datos en el backend.');
    }
    const emailNormalizado = this.normalizarEmail(email);
    if (!emailNormalizado || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalizado)) {
      throw new ConflictException('Ese correo no parece válido.');
    }
    if (!password || String(password).length < 6) {
      throw new ConflictException('La contraseña debe tener al menos 6 caracteres.');
    }

    const existente = await this.pool.query(`SELECT id FROM usuarios WHERE email = $1`, [emailNormalizado]);
    if ((existente.rowCount ?? 0) > 0) {
      throw new ConflictException('Ya existe una cuenta con ese correo. Iniciá sesión en vez de registrarte.');
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const resultado = await this.pool.query(
      `INSERT INTO usuarios (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
      [emailNormalizado, passwordHash],
    );
    const usuario: UsuarioPublico = { id: resultado.rows[0].id, email: resultado.rows[0].email };
    this.logger.log(`Nueva cuenta registrada: ${usuario.email}`);
    return { ...usuario, token: this.firmarToken(usuario) };
  }

  async login(email: string, password: string): Promise<SesionResultado> {
    if (!this.pool) {
      throw new InternalServerErrorException('El inicio de sesión no está disponible: falta configurar la base de datos en el backend.');
    }
    const emailNormalizado = this.normalizarEmail(email);
    const resultado = await this.pool.query(
      `SELECT id, email, password_hash FROM usuarios WHERE email = $1`,
      [emailNormalizado],
    );
    const fila = resultado.rows[0];
    // Mismo mensaje genérico tanto si el correo no existe como si la
    // contraseña está mal — así no se le confirma a quien intente adivinar
    // si un correo específico ya está registrado.
    if (!fila || !(await bcrypt.compare(String(password || ''), fila.password_hash))) {
      throw new UnauthorizedException('Correo o contraseña incorrectos.');
    }
    const usuario: UsuarioPublico = { id: fila.id, email: fila.email };
    return { ...usuario, token: this.firmarToken(usuario) };
  }

  // Usado por AuthGuard en cada pedido protegido: valida la firma del token
  // (y que no haya vencido) y devuelve quién es. Si el token es inválido o
  // vencido, lanza UnauthorizedException.
  verificarToken(token: string): UsuarioPublico {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as jwt.JwtPayload;
      return { id: Number(payload.sub), email: String(payload.email || '') };
    } catch {
      throw new UnauthorizedException('Sesión inválida o vencida — volvé a iniciar sesión.');
    }
  }
}
