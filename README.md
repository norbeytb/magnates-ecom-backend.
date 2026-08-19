# Módulo IA — GPT Image 2 vía fal.ai

Código real para el "Agente de Imagen" del Módulo IA (Prompt 12 de la
arquitectura). Reemplaza al FLUX.1 Kontext de la primera versión: ahora usa
**GPT Image 2**, que sí resuelve bien el texto (título, precios, viñetas)
directamente dentro de la imagen generada.

## Por qué GPT Image 2 (y por qué a través de fal.ai)

- Tu foto de producto se mantiene intacta (el prompt se lo pide explícitamente).
- El texto que genera (títulos, precios, beneficios) tiene ~95% de precisión,
  a diferencia de modelos anteriores que renderizaban texto ilegible.
- Usarlo a través de fal.ai (en vez de la API directa de OpenAI) te deja con
  **una sola cuenta, una sola clave, un solo panel de facturación** — ya la
  tienes configurada con método de pago.

## Instalación

```bash
npm install @fal-ai/client
```

## Configuración

Variable de entorno del backend (nunca en el frontend, nunca en git):

```
FAL_API_KEY=tu_clave_de_fal.ai
```

## Archivos

- `image-edit.service.ts` — llama a `fal-ai/gpt-image-2` y arma el prompt
  según la sección elegida (Hero, Oferta, Logística, Antes/Después,
  Beneficios, Testimonios, Autoridad, Modo de uso, FAQ, Tabla), usando
  solo los campos de la ficha técnica que aplican a cada una:
  - **Hero**: nombre del producto, ángulo de venta, detalles del producto.
  - **Oferta**: los 3 precios (1/2/3 unidades) + divisa configurados en
    "🏷 Configuración para la sección de oferta".
  - **Logística**: país y método de pago de "🚚 Configuración para la
    sección logística".
  - **Antes y Después**: problema (⚠) y resultado deseado (◎).
  - **Beneficios / Testimonios / Autoridad / Modo de uso / FAQ / Tabla**:
    combinan detalles del producto, avatar, solución (💡) y mecanismo (≡)
    según corresponda.
  - **Personaje** (👥 Características de los personajes): se incluye en
    Hero, Antes/Después, Testimonios, Autoridad y Modo de uso — nunca en
    Oferta, Logística, Beneficios, Tabla o FAQ, que no muestran personas.
  - **Instrucciones adicionales** (💬): se agregan siempre, al final.
- `image-edit.controller.ts` — endpoint `POST /ia/imagenes/generar-seccion`
  que recibe todos esos campos desde el taller.

## Cómo se conectaría el botón "✨ Generar Sección" del taller

El taller ya tiene IDs en todos los campos relevantes
(`fProducto`, `fAngulo`, `fProblema`, `fAvatar`, `fResultado`, `fSolucion`,
`fMecanismo`, `fInstrucciones`, `fPersonajeNacionalidad`, `fPersonajeSexo`,
`fPersonajeEdadDesde/Hasta`, `fPrecio1-3Venta/Comparacion`). Cuando despliegues
este backend, el `onclick` de "Generar Sección" haría algo así:

```javascript
async function generarSeccionReal(seccionKey, productoImgUrl) {
  const val = id => document.getElementById(id)?.value || '';
  const resp = await fetch('https://TU-BACKEND.com/ia/imagenes/generar-seccion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seccion: seccionKey,
      imagenProductoUrl: productoImgUrl,
      colorHex: document.getElementById('colorLabel')?.textContent,
      nombreProducto: currentProduct,
      detallesProducto: val('fProducto'),
      angulo: val('fAngulo'),
      problema: val('fProblema'),
      avatar: val('fAvatar'),
      resultado: val('fResultado'),
      solucion: val('fSolucion'),
      mecanismo: val('fMecanismo'),
      instrucciones: val('fInstrucciones'),
      personajes: {
        nacionalidad: val('fPersonajeNacionalidad'),
        sexo: val('fPersonajeSexo'),
        edadDesde: val('fPersonajeEdadDesde'),
        edadHasta: val('fPersonajeEdadHasta'),
      },
      oferta: {
        precio1Venta: val('fPrecio1Venta'), precio1Comparacion: val('fPrecio1Comparacion'),
        precio2Venta: val('fPrecio2Venta'), precio2Comparacion: val('fPrecio2Comparacion'),
        precio3Venta: val('fPrecio3Venta'), precio3Comparacion: val('fPrecio3Comparacion'),
        divisa: document.getElementById('divisaTrigger')?.textContent,
      },
      logistica: {
        pais: document.getElementById('paisLogisticaTrigger')?.textContent,
        metodoPago: document.getElementById('metodoPagoTrigger')?.textContent,
      },
    }),
  });
  return resp.json(); // { imagenesUrl, promptUsado, costoEstimadoUsd }
}
```

**Importante**: esta llamada solo funciona una vez que `TU-BACKEND.com` esté
desplegado de verdad con `FAL_API_KEY` configurada. Abrir el archivo HTML del
taller directamente en el navegador nunca podrá ejecutar esto — necesita un
servidor real corriendo.

## Costo de referencia (calidad alta, la usada por defecto)

**$0.211 por imagen.** Con calidad media baja a $0.041, y baja a $0.006 —
podrías usar calidad baja/media para vistas previas rápidas y alta solo para
la pieza final que el usuario decide publicar (ajustar `quality` en el
service).

## Pendientes para integrarlo de verdad

- [ ] Registrar el costo de cada llamada en el sistema de costos de IA
      (Prompt 9).
- [ ] Definir límites de uso por plan/usuario (evitar abuso de créditos).
- [ ] Manejar reintentos y timeouts (la generación puede tardar varios
      segundos).
- [ ] Decidir dónde se guardan las imágenes generadas (S3/equivalente) o si
      se sirven desde la URL temporal de fal.ai.
- [ ] Subir la foto de producto a una URL pública antes de llamar a este
      endpoint (fal.ai necesita una URL, no un archivo local — se puede usar
      `fal.storage.upload()` del mismo SDK para esto).
- [ ] Decidir la calidad por defecto (alta = mejor resultado, pero 5x más
      cara que la calidad media).
