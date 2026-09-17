// opentype.d.ts
//
// Declaración de tipos MÍNIMA y propia para "opentype.js" — este archivo va
// en src/, al lado de los demás .ts.
//
// Por qué existe: "opentype.js" no trae sus propios tipos de TypeScript, y
// el paquete de tipos de la comunidad (@types/opentype.js) dio problemas al
// instalarlo junto con el paquete real en pruebas (uno "reemplazaba" al
// otro). En vez de depender de eso, esto declara a mano solo las 4 piezas
// que realmente usa importar-producto.service.ts — konsistente con cómo ya
// se resolvió una fricción parecida con "sharp" en su momento (ver el
// comentario de la importación de sharp en ese archivo).
declare module 'opentype.js' {
  export class Path {
    toPathData(decimalPlaces?: number): string;
  }

  export class Font {
    getPath(text: string, x: number, y: number, fontSize: number): Path;
    getAdvanceWidth(text: string, fontSize?: number): number;
  }

  export function parse(buffer: ArrayBuffer): Font;
}
