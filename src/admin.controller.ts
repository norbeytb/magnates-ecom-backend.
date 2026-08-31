// admin.controller.ts
//
// Endpoints solo para administradores (los correos que estén en la variable
// de entorno ADMIN_EMAILS de Railway, separados por coma — ver la nota
// grande arriba del todo de auth.service.ts). Le dejan al administrador ver
// la lista de todos los usuarios registrados y cambiarle la contraseña a
// cualquiera de ellos a mano.
//
// Por qué existe esto: mientras no haya un dominio propio verificado para
// mandar correos reales, "olvidé mi contraseña" no puede ser automático
// (Railway bloquea SMTP en el plan gratis, y los servicios de correo por
// HTTPS como Resend piden un dominio propio para mandarle correo a
// cualquiera). Así que, por ahora, cuando alguien necesita recuperar el
// acceso escribe al soporte (correo o WhatsApp — ver el botón "¿Olvidaste tu
// contraseña?" en la pantalla de inicio de sesión del taller) y el
// administrador entra acá a cambiarle la contraseña directamente.

import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard, UsuarioActual, UsuarioAutenticado } from './auth.guard';

interface RestablecerPasswordAdminDto {
  password: string;
}

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly authService: AuthService) {}

  // JwtAuthGuard ya exige estar logueado — esto exige, además, que la
  // cuenta logueada sea una de administrador. Se revisa en cada método (en
  // vez de un guard aparte) porque son solo dos endpoints; si se agregan más
  // adelante, conviene pasar esto a su propio AdminGuard.
  private exigirAdmin(usuario: UsuarioAutenticado) {
    if (!usuario.esAdmin) {
      throw new ForbiddenException('No tenés permiso para ver esto.');
    }
  }

  @Get('usuarios')
  async listarUsuarios(@UsuarioActual() usuario: UsuarioAutenticado) {
    this.exigirAdmin(usuario);
    return this.authService.listarUsuarios();
  }

  @Post('usuarios/:id/restablecer-password')
  async restablecerPassword(
    @Param('id') id: string,
    @Body() dto: RestablecerPasswordAdminDto,
    @UsuarioActual() usuario: UsuarioAutenticado,
  ) {
    this.exigirAdmin(usuario);
    return this.authService.restablecerPasswordAdmin(Number(id), dto?.password);
  }
}
