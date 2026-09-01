// auth.guard.ts
//
// Guardia que protege un endpoint: exige el header
// "Authorization: Bearer <token>" con un token válido (el que devuelve
// /auth/registro o /auth/login) antes de dejar pasar el pedido. Si falta o
// es inválido, corta con 401 antes de que el controlador llegue a ejecutarse
// — así ningún endpoint del backend (generar imágenes con IA, publicar en
// Shopify, leer/guardar productos, etc.) queda abierto para cualquiera que
// encuentre la URL del backend.
//
// Se usa así en un controlador:
//   @UseGuards(JwtAuthGuard)
//   @Controller('productos')
//   export class ProductosController { ... }
//
// y adentro de cada método, para saber DE QUIÉN es el pedido:
//   async listarFotos(@UsuarioActual() usuario: UsuarioAutenticado) {
//     return this.productosService.listarFotos(usuario.id);
//   }

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { AuthService } from './auth.service';

export interface UsuarioAutenticado {
  id: number;
  email: string;
  nombre?: string;
  apellido?: string;
  // Calculado en cada pedido (ver AuthService.verificarToken) comparando el
  // correo contra ADMIN_EMAILS — así, si en algún momento se agrega o saca
  // un correo de esa variable en Railway, el cambio aplica al toque, sin
  // que la persona tenga que volver a iniciar sesión para que se note.
  esAdmin: boolean;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req: any = context.switchToHttp().getRequest();
    const encabezado: string | undefined = req.headers?.authorization;
    const token = encabezado && encabezado.startsWith('Bearer ') ? encabezado.slice('Bearer '.length).trim() : null;
    if (!token) {
      throw new UnauthorizedException('Falta iniciar sesión.');
    }
    // Lanza UnauthorizedException si el token es inválido/venció — se deja
    // propagar tal cual, Nest la convierte sola en un 401 para el taller.
    const usuario = this.authService.verificarToken(token);
    // Revisa en la base de datos si un administrador bloqueó esta cuenta
    // (ver auth.service.ts, verificarNoBloqueado/bloquearUsuario) — a
    // propósito EN CADA PEDIDO, no solo al iniciar sesión: el token dura 30
    // días, así que sin este chequeo alguien bloqueado seguiría teniendo
    // acceso hasta que ese token venza solo. Lanza ForbiddenException (403)
    // si está bloqueada.
    await this.authService.verificarNoBloqueado(usuario.id);
    // Queda disponible en el resto del pedido a través de @UsuarioActual().
    req.usuario = usuario;
    return true;
  }
}

// Decorador de parámetro para leer, dentro de cualquier método de un
// controlador ya protegido por JwtAuthGuard, quién es el usuario autenticado
// sin tener que repetir "req.usuario" en cada uno.
export const UsuarioActual = createParamDecorator((_data: unknown, context: ExecutionContext): UsuarioAutenticado => {
  const req: any = context.switchToHttp().getRequest();
  return req.usuario;
});
