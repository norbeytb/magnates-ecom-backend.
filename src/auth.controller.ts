// auth.controller.ts
//
// Endpoints de cuentas: registrarse, iniciar sesión, y consultar quién está
// conectado (lo usa el taller al abrir la página, para saber si ya hay una
// sesión guardada y que valga la pena, o si hay que mostrar la pantalla de
// entrada). El correo/contraseña viajan por HTTPS (Railway lo da por
// defecto) — nunca se guardan en el backend, solo se validan una vez y se
// devuelve un token.

import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';

interface CredencialesDto {
  email: string;
  password: string;
  // Solo se usan al registrarse (el formulario de "Crear cuenta" del taller
  // los pide) — el login no los necesita.
  nombre?: string;
  apellido?: string;
}

// Usado por "Mi Perfil" del taller — cambiar nombre/apellido/correo no pide
// la contraseña (no es un dato sensible como para exigirla de nuevo), pero
// si el usuario ya inició sesión es porque ya la probó al entrar.
interface ActualizarPerfilDto {
  nombre?: string;
  apellido?: string;
  email?: string;
}

// Cambiar la propia contraseña SÍ exige la contraseña actual — a diferencia
// del panel de administración (restablecerPasswordAdmin), donde un
// administrador la cambia sin saber la vieja.
interface CambiarPasswordDto {
  passwordActual: string;
  passwordNueva: string;
}

// Ver la nota grande en auth.service.ts (generarPaseSso/entrarConPase) para
// el porqué de estos dos. "email"/"secreto" son los nombres de campo que ya
// espera MEC Control de su lado (app/creadora-landing/route.ts) — si alguna
// vez se cambian acá, hay que avisar para actualizar los dos lados juntos.
interface GenerarPaseSsoDto {
  email: string;
  secreto: string;
}

interface EntrarConPaseDto {
  pase: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('registro')
  async registro(@Body() dto: CredencialesDto) {
    return this.authService.registrar(dto?.email, dto?.password, dto?.nombre, dto?.apellido);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: CredencialesDto) {
    return this.authService.login(dto?.email, dto?.password);
  }

  // El taller lo llama al cargar la página con el token guardado en
  // localStorage, para confirmar que sigue siendo válido antes de mostrar el
  // taller directo (si no, manda de vuelta a la pantalla de entrada).
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@UsuarioActual() usuario: UsuarioAutenticado) {
    return usuario;
  }

  // "Mi Perfil" del taller — editar nombre/apellido/correo de la propia
  // cuenta. Devuelve un token nuevo (ver auth.service.ts) porque esos datos
  // van adentro del token.
  @Post('perfil')
  @UseGuards(JwtAuthGuard)
  async actualizarPerfil(@Body() dto: ActualizarPerfilDto, @UsuarioActual() usuario: UsuarioAutenticado) {
    return this.authService.actualizarPerfil(usuario.id, dto);
  }

  // "Mi Perfil" del taller — cambiar la contraseña de la propia cuenta,
  // pidiendo la actual como confirmación.
  @Post('cambiar-password')
  @UseGuards(JwtAuthGuard)
  async cambiarPassword(@Body() dto: CambiarPasswordDto, @UsuarioActual() usuario: UsuarioAutenticado) {
    return this.authService.cambiarPasswordPropia(usuario.id, dto?.passwordActual, dto?.passwordNueva);
  }

  // ---------------- INICIO DE SESIÓN ÚNICO (SSO) CON MEC CONTROL ----------------
  // Ninguno de los dos lleva @UseGuards(JwtAuthGuard) — a propósito, porque
  // ninguno de los dos tiene todavía un token normal de esta plataforma:
  //
  //   - "sso/generar-pase" lo llama el SERVIDOR de MEC Control (nunca un
  //     navegador), autenticándose con el secreto compartido en vez de un
  //     token de acá.
  //   - "sso/entrar" lo llama el navegador del estudiante con el pase que
  //     acaba de recibir en la URL — todavía no tiene ninguna sesión
  //     abierta en esta plataforma, es justo lo que este endpoint le da.
  @Post('sso/generar-pase')
  @HttpCode(200)
  async generarPaseSso(@Body() dto: GenerarPaseSsoDto) {
    return this.authService.generarPaseSso(dto?.email, dto?.secreto);
  }

  @Post('sso/entrar')
  @HttpCode(200)
  async entrarConPase(@Body() dto: EntrarConPaseDto) {
    return this.authService.entrarConPase(dto?.pase);
  }
}
