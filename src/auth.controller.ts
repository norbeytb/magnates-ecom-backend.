// auth.controller.ts
//
// Endpoints de cuentas: registrarse, iniciar sesión, y consultar quién está
// conectado (lo usa el taller al abrir la página, para saber si ya hay una
// sesión guardada y que valga la pena, o si hay que mostrar la pantalla de
// entrada). El correo/contraseña viajan por HTTPS (Railway lo da por
// defecto) — nunca se guardan en el backend, solo se validan una vez y se
// devuelve un token.

import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { IntegracionesService } from './integraciones.service';
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

// Fix 28/09 (pedido: que la integración de Shopify que se haga en MEC
// Control quede ya configurada acá, sin que el usuario tenga que volver a
// conectarla): mismo criterio de autenticación que "sso/generar-pase" de
// arriba — lo llama el SERVIDOR de MEC Control (nunca un navegador),
// probándose con el secreto compartido, nunca con un token de acá. "shopKey"
// es el identificador que MEC Control ya usa para esa tienda en su propia
// base (ver lib/shopifyCreds.ts del lado de MEC Control) — se reutiliza tal
// cual para que reconectar/renombrar la misma tienda actualice siempre la
// misma fila en vez de duplicarla (ver guardarTiendaShopifyDesdeSso en
// integraciones.service.ts).
interface SincronizarShopifyDto {
  email: string;
  secreto: string;
  shopKey: string;
  nombre?: string;
  storeDomain: string;
  clientId: string;
  clientSecret: string;
}

interface DesconectarShopifySsoDto {
  email: string;
  secreto: string;
  shopKey: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly integracionesService: IntegracionesService,
  ) {}

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

  // ------- Sincronizar tiendas de Shopify conectadas en MEC Control -------
  // Igual que "sso/generar-pase": lo llama el servidor de MEC Control, nunca
  // un navegador, autenticándose con el secreto compartido — nunca con un
  // token de acá. Resuelve (o crea, si el estudiante nunca entró al taller)
  // el usuario_id a partir del correo, y guarda/borra esa tienda puntual en
  // "shopify_tiendas" para ESE usuario. Sin @UseGuards a propósito, mismo
  // motivo que sso/generar-pase de arriba.
  @Post('sso/shopify-tienda')
  @HttpCode(200)
  async sincronizarShopifyDesdeSso(@Body() dto: SincronizarShopifyDto) {
    const usuarioId = await this.authService.obtenerUsuarioIdSso(dto?.email, dto?.secreto);
    return this.integracionesService.guardarTiendaShopifyDesdeSso(
      usuarioId,
      dto?.shopKey,
      dto?.nombre || '',
      dto?.storeDomain,
      dto?.clientId,
      dto?.clientSecret,
    );
  }

  @Delete('sso/shopify-tienda')
  @HttpCode(200)
  async desconectarShopifyDesdeSso(@Body() dto: DesconectarShopifySsoDto) {
    const usuarioId = await this.authService.obtenerUsuarioIdSso(dto?.email, dto?.secreto);
    return this.integracionesService.borrarTiendaShopifyDesdeSso(usuarioId, dto?.shopKey);
  }
}
