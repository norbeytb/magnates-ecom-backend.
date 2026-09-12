// text-generation.service.ts
//
// Módulo IA — Agente de Copywriting (texto). Antes esta llamada la hacía el
// propio navegador del usuario, pidiéndole que pegara su propia API Key de
// Anthropic; después pasó a vivir en el backend usando una ANTHROPIC_API_KEY
// compartida del servidor.
//
// Ahora usa la MISMA clave de fal.ai que el usuario ya conectó para generar
// imágenes (ver integraciones.service.ts / image-edit.service.ts) — a
// propósito, para que cada estudiante tenga UNA sola clave que pagar y
// conectar, no dos. fal.ai expone modelos de texto (incluido Claude) a
// través de su endpoint unificado "fal-ai/any-llm", autenticado con la misma
// clave que los modelos de imagen — por eso ya no hace falta una
// ANTHROPIC_API_KEY aparte ni que el usuario pegue una segunda clave.

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createFalClient } from '@fal-ai/client';

export interface GenerarCopyInput {
  nombreProducto: string;
  detallesProducto: string;
  // Si viene presente: el usuario ya eligió uno de los 3 ángulos que le
  // propuso generarAngulos() (ver abajo), y este método NO debe inventar
  // uno nuevo — solo redactar el resto de los campos (problema, avatar,
  // resultado, solución, mecanismo) coherentes con ESE ángulo puntual. Si
  // viene vacío/ausente, se mantiene el comportamiento viejo: el modelo
  // elige él mismo un único ángulo y lo devuelve también.
  anguloElegido?: string;
  // Pedido 07/09: idioma en el que debe salir redactado todo el copy — por defecto 'Español'
  // (ver "🌐 Idioma de Salida" en el taller). Sirve para landings armadas para otro país.
  idioma?: string;
  // Pedido 09/09: "País donde vas a vender" del taller — ya existía ese campo pero antes solo
  // se usaba para la nacionalidad del personaje en la imagen, nunca para adaptar el TONO del
  // copy (ver TONO_POR_PAIS más abajo). Vacío/ausente = sin adaptación de tono (como hasta ahora).
  pais?: string;
  // La clave de fal.ai DE ESE USUARIO — el controlador la busca antes de
  // llamar acá y avisa con un error claro si el usuario todavía no la
  // conectó en "Integraciones".
  falApiKey: string;
}

export interface GenerarCopyResultado {
  angulo: string;
  problema: string;
  avatar: string;
  resultado: string;
  solucion: string;
  mecanismo: string;
}

export interface GenerarAngulosInput {
  nombreProducto: string;
  detallesProducto: string;
  idioma?: string; // ver nota en GenerarCopyInput
  pais?: string; // ver nota en GenerarCopyInput
  falApiKey: string;
}

export interface GenerarAngulosResultado {
  // Siempre 3 ángulos de venta distintos entre sí, para que el usuario
  // elija con cuál seguir (ver generarAngulos()).
  angulos: string[];
}

// Pedido 11/09: sección "Testimonios" en modo Personalizada — a diferencia
// de generarAngulos/generarCopy (que redactan publicidad desde cero), acá
// el estudiante ya escribió el texto REAL que le mandó un cliente real, y
// la IA solo lo adapta (pulir ortografía/redacción, nunca inventar
// contenido nuevo) y le agrega un nombre + ciudad genéricos acordes al país
// de venta. Ver adaptarResena() más abajo.
export interface AdaptarResenaInput {
  textoOriginal: string;
  nombreProducto: string;
  idioma?: string; // ver nota en GenerarCopyInput
  pais?: string; // mismo país de logística/envío ya configurado, ver ShopifyService
  // Nombres/ciudades ya usados en otras reseñas de esta misma landing, para
  // que la IA no repita el mismo nombre o ciudad dos veces.
  nombresUsados?: string[];
  ciudadesUsadas?: string[];
  falApiKey: string;
}

export interface AdaptarResenaResultado {
  nombre: string;
  ciudad: string;
  estrellas: number; // 4 o 5 — nunca se publican reseñas negativas
  texto: string;
}

// Pedido 11/09 (pivote): el estudiante ya no escribe ningún texto — sube
// SOLO una foto real por reseña (puede subir varias de una) y la IA
// redacta el texto completo mirando la foto (usa un modelo con visión, ver
// llamarFalVision() más abajo). El estudiante confirmó explícitamente que
// acepta que el texto sea una opinión creíble INVENTADA por la IA a partir
// de lo que se ve en la imagen, nunca una cita textual de un cliente real.
export interface GenerarResenaDesdeFotoInput {
  fotoUrl: string;
  nombreProducto: string;
  idioma?: string; // ver nota en GenerarCopyInput
  pais?: string; // mismo país de logística/envío ya configurado, ver ShopifyService
  // Nombres/ciudades ya usados en otras reseñas de esta misma landing, para
  // que la IA no repita el mismo nombre o ciudad dos veces.
  nombresUsados?: string[];
  ciudadesUsadas?: string[];
  falApiKey: string;
}

// Pedido 11/09 (versión final, confirmada con Norbey): la foto que sube el
// estudiante se publica TAL CUAL (nunca se le pide nada a la IA sobre esa
// foto — ni que la mire, ni que la edite) y el avatar es una imagen aparte
// generada por ImageEditService.generarAvatarResena(). Esta llamada de acá
// es SOLO TEXTO: inventa nombre/ciudad/estrellas/texto de una reseña
// creíble para el producto, sin mirar ninguna imagen — reemplaza en la
// práctica a generarResenaDesdeFoto() (que queda sin usar, ver arriba) y ya
// no depende del endpoint de visión de fal.ai que venía fallando.
export interface GenerarTextoResenaInput {
  nombreProducto: string;
  idioma?: string; // ver nota en GenerarCopyInput
  pais?: string; // mismo país de logística/envío ya configurado, ver ShopifyService
  nombresUsados?: string[];
  ciudadesUsadas?: string[];
  // Pedido 12/09 (bug reportado por Norbey, con captura: 3 reseñas seguidas
  // con la misma estructura de frase — "Llevo X tiempo usando/tomando el
  // producto y la verdad es que..." — solo cambiaban un par de palabras
  // sueltas, algo que delata al toque que son reseñas fabricadas). Estos dos
  // campos son la forma de resolverlo — ver el comentario grande junto a
  // ENFOQUES_RESENA, más abajo.
  textosUsados?: string[];
  indice?: number;
  // Pedido 12/09 (bug reportado por Norbey, con captura: avatar de un hombre
  // publicado con el nombre "Catalina V."): el avatar (la foto/carita) y el
  // nombre de la reseña se generan en dos llamadas separadas (esta y
  // ImageEditService.generarAvatarResena) que antes no se comunicaban entre
  // sí — si el "Sexo" del Personaje no estaba fijo en un solo valor, cada
  // llamada elegía uno al azar por su cuenta y podían no coincidir. Ahora el
  // frontend decide UN solo sexo por reseña y se lo manda a las dos — este
  // campo ("Hombre" o "Mujer") es ese valor, y se usa para que el nombre
  // inventado acá sea siempre acorde al avatar.
  sexo?: string;
  falApiKey: string;
}

// Pedido 12/09: cada reseña se genera con una llamada INDEPENDIENTE al
// modelo, que no tiene memoria de lo que escribió en las reseñas
// anteriores — dejado solo, el modelo tiende a converger siempre a la misma
// plantilla "segura" para un mismo producto (ej. "Llevo tres semanas usando
// el Shilajit Ultra y la verdad es que me siento con más energía durante el
// día..."), cambiando apenas un par de palabras entre una reseña y la
// siguiente. Pedirle "no repitas la estructura" en texto libre no alcanzó
// (ver la nota vieja en el prompt, más abajo) porque el modelo no tiene
// ninguna referencia concreta de qué estructura ya usó. La solución: asignar
// a CADA reseña, según su posición en la lista (índice), un ángulo/enfoque
// distinto de esta lista fija — así la variedad de contenido queda
// garantizada por diseño, no librada a que al modelo "se le ocurra" variar
// solo. Se combina con mandarle los textos ya usados (textosUsados) como
// referencia negativa explícita.
const ENFOQUES_RESENA: string[] = [
  'Contá un resultado o cambio concreto y específico que notaste usándolo — no algo genérico como "más energía", sino algo puntual (qué pudiste hacer, qué dejó de pasar, qué mejoró).',
  'Contá cómo lo metiste en tu rutina diaria: en qué momento del día lo usás y cómo se volvió parte de tu día a día.',
  'Compará cómo era tu situación ANTES de tenerlo con cómo es AHORA — el contraste entre un momento y otro.',
  'Contá que se lo recomendaste, regalaste o mostraste a alguien cercano (un familiar, un amigo, un compañero de trabajo) y por qué.',
  'Hablá de algo puntual del producto en sí — la calidad, el empaque, lo fácil que es de usar, o el sabor/textura si aplica — más que del resultado.',
  'Contá una anécdota corta y bien específica: un momento, un día o una situación puntual donde te diste cuenta de la diferencia.',
  'Hablá de la relación precio-calidad: por qué sentiste que valió la pena la compra frente a otras opciones.',
  'Escribila corta y directa, sin mucha explicación — como alguien que no tiene tiempo de escribir mucho pero quiere dejar su opinión de todas formas.',
];

// Modelo de Claude servido a través del router de fal.ai (fal-ai/any-llm) —
// mismo modelo (Haiku) que se usaba antes llamando directo a la API de
// Anthropic: alcanza de sobra para esta tarea (redactar texto corto y
// estructurado) y es el más económico de la familia Claude.
const MODELO_TEXTO = 'anthropic/claude-haiku-4.5';

// Se repite en los dos prompts (generarAngulos y generarCopy) porque las dos
// llamadas producen texto que después se usa para generar imágenes con IA.
const REGLA_CONTENIDO = `REGLA IMPORTANTE (especialmente para productos de belleza/moda/salud/fitness): este texto se usa después para generar imágenes con IA, y cualquier mención a cirugía, procedimientos médicos/quirúrgicos, tratamientos clínicos, riesgos de salud, o comparaciones tipo "sin cirugía"/"sin necesidad de operarte" hace que la generación de imagen se bloquee por filtros de contenido. NUNCA menciones cirugía, procedimientos quirúrgicos/médicos, ni riesgos de salud, ni siquiera para decir que el producto es la alternativa segura o más rápida. Describe el producto solo por sus beneficios directos (comodidad, estilo, practicidad, apariencia, confianza), nunca comparándolo con un procedimiento médico.`;

// Pedido 09/09 (punto 5 de la lista analizada del prompt de referencia "Joel"): antes solo
// evitábamos temas médicos/quirúrgicos (ver REGLA_CONTENIDO) — esto agrega una regla de
// honestidad más general, separada porque aplica siempre, para cualquier categoría de
// producto (no solo belleza/salud). Además de ser más profesional, este tipo de palabras
// también puede hacer que Meta/TikTok Ads rechace el anuncio por publicidad engañosa.
const REGLA_ANTIEXAGERACION = `REGLA DE HONESTIDAD: nunca prometas resultados exagerados, mágicos o sin respaldo — evitá palabras como "milagroso", "mágico", "instantáneo", "cura", "garantizado al 100%" o similares. Describe el beneficio real del producto de forma directa y creíble, sin promesas imposibles de cumplir.`;

// Pedido 09/09 (bug reportado por Norbey, con captura del error real): un estudiante escribió en
// "Detalles del producto" una instrucción tipo "investiga sobre el producto y traeme la
// información" en vez de datos reales del producto. Este modelo NO tiene ningún buscador
// conectado (ver llamarFal() más abajo: es una única llamada de texto, sin herramientas), así
// que no podía "investigar" nada — y al no tener información real para trabajar, respondió con
// una aclaración en texto libre (algo como "no tengo acceso a internet para investigar, pero...")
// en vez del JSON estricto pedido. Eso rompió el JSON.parse() de llamarFal() y terminó en un 500
// ("La respuesta de fal.ai no fue un JSON válido"), tirando al usuario al modo demo (simulado)
// del frontend sin que quedara claro por qué. Ya existía la instrucción de "Responde ÚNICAMENTE
// con un objeto JSON válido" en cada prompt, pero no alcanzó frente a un pedido que empuja al
// modelo a priorizar la honestidad sobre el formato. Se agrega esta regla aparte, bien explícita,
// para blindar el formato de salida pase lo que pase con lo que el usuario haya escrito.
const REGLA_FORMATO_JSON = `REGLA DE FORMATO (no negociable, aplica siempre): no tenés acceso a internet ni a ningún buscador — no podés "investigar" el producto aunque te lo pidan, solo podés trabajar con el nombre del producto y el texto de "detalles del producto" que te dieron. Sin importar qué tan completa, vaga o inusual sea esa información — incluso si en vez de datos reales el texto es una instrucción como "investiga sobre el producto" o casi no dice nada — NUNCA respondas con una aclaración, disculpa, pregunta o cualquier texto libre explicando que no podés investigar o que falta información. Siempre devolvé ÚNICAMENTE el objeto JSON exacto que se pide más abajo, haciendo tu mejor esfuerzo posible con el nombre del producto y lo poco o mucho que te hayan dado. Romper el formato JSON no es una opción bajo ninguna circunstancia.`;

// Pedido 09/09 (punto 4 de la misma lista): "País donde vas a vender" ya existía en el taller
// pero solo se usaba para la nacionalidad del personaje en la imagen — nunca para adaptar el
// TONO del copy. Estos 7 son los mismos países/tonos curados a mano del prompt de referencia;
// para cualquier OTRO país de la lista del taller (son bastantes más — ver el dropdown), se le
// pide al modelo que infiera un tono apropiado él mismo en vez de dejar una tabla enorme a
// mano, ver notaPais más abajo.
const TONO_POR_PAIS: Record<string, string> = {
  Colombia: 'cálido, cercano y confiable',
  México: 'directo, enérgico y aspiracional',
  Perú: 'formal pero accesible, orientado a la familia',
  Chile: 'sobrio, informativo, con datos concretos',
  Argentina: 'seguro, inteligente, con personalidad propia',
  Ecuador: 'neutro, claro, enfocado en el valor',
  'Estados Unidos': 'neutro, claro, enfocado en el valor',
};

function notaTonoPorPais(pais: string | undefined): string {
  const paisLimpio = (pais || '').trim();
  // 'Selecciona el país' es el texto por defecto del dropdown cuando el usuario nunca lo tocó
  // — en ese caso no hay país para adaptar, se sigue igual que hasta ahora (sin nota de tono).
  if (!paisLimpio || paisLimpio === 'Selecciona el país') return '';
  const tono = TONO_POR_PAIS[paisLimpio];
  return ` Además, adaptá el tono, los modismos suaves y las referencias culturales para alguien de ${paisLimpio}${tono ? ` — un tono ${tono}` : ''}, sin caer en modismos vulgares o demasiado locales que puedan sonar raros para el resto de lectores de ese mismo país.`;
}

@Injectable()
export class TextGenerationService {
  // Primer paso del "Completar con IA": antes de redactar toda la
  // estrategia, le pide al modelo 3 ángulos de venta distintos entre sí
  // (mismo producto, 3 enfoques de marketing diferentes) para que el
  // usuario elija con cuál seguir — en vez de que el modelo elija uno solo
  // sin consultarle. El segundo paso (generarCopy, más abajo) recibe el
  // ángulo ya elegido y redacta el resto en base a ÉL.
  async generarAngulos(input: GenerarAngulosInput): Promise<GenerarAngulosResultado> {
    if (!input.falApiKey) {
      throw new InternalServerErrorException('Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.');
    }

    const idioma = (input.idioma || 'Español').trim() || 'Español';
    const notaIdioma =
      idioma.toLowerCase() !== 'español'
        ? ` IMPORTANTE: el estudiante va a vender en un país donde se habla ${idioma} — redacta cada ángulo directamente en ${idioma}, no en español.`
        : '';
    const notaPais = notaTonoPorPais(input.pais);

    const systemPrompt = `Eres un equipo experto compuesto por: especialista en eCommerce, copywriter senior de respuesta directa, especialista en Meta Ads y TikTok Ads, y especialista en CRO (Conversion Rate Optimization).

Tu tarea es analizar la ficha técnica de un producto (de cualquier categoría: hogar, belleza, salud, fitness, mascotas, tecnología, moda, etc.) y proponer 3 ángulos de venta distintos y con buen potencial de conversión, cada uno con un enfoque de marketing realmente diferente entre sí (por ejemplo: uno centrado en el dolor/problema a evitar, otro en la aspiración/transformación deseada, otro en un diferenciador o mecanismo único) — nunca 3 variaciones de la misma idea con otras palabras.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después, sin bloques de markdown, con exactamente esta clave:
{"angulos":["...","...","..."]}

Cada uno de los 3 elementos del array es el nombre corto de un ángulo de venta (una frase concreta y específica al producto, en ${idioma}, de no más de 12 palabras — el mismo estilo que "Alivio del dolor de espalda sin cirugía ni medicamentos" o "Pérdida de peso natural, sin dietas extremas ni rutinas complicadas", traducido al espíritu de ${idioma}), nunca genérico ni aplicable a cualquier producto.${notaIdioma}${notaPais}

${REGLA_CONTENIDO}

${REGLA_ANTIEXAGERACION}

${REGLA_FORMATO_JSON}`;

    const userMsg = `Nombre del producto: ${input.nombreProducto}\n\nFicha técnica / detalles del producto:\n${input.detallesProducto}`;

    const datos = await this.llamarFal(input.falApiKey, userMsg, systemPrompt);
    if (!Array.isArray(datos.angulos) || datos.angulos.length < 1) {
      throw new InternalServerErrorException('La respuesta de fal.ai no incluyó ángulos de venta.');
    }
    // Por las dudas el modelo devuelva más o menos de 3, nos quedamos con
    // hasta 3 — el frontend siempre muestra los que le lleguen.
    return { angulos: datos.angulos.slice(0, 3).map((a: unknown) => String(a)) };
  }

  async generarCopy(input: GenerarCopyInput): Promise<GenerarCopyResultado> {
    if (!input.falApiKey) {
      throw new InternalServerErrorException('Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.');
    }

    const anguloElegido = input.anguloElegido?.trim();
    const idioma = (input.idioma || 'Español').trim() || 'Español';
    const notaIdioma =
      idioma.toLowerCase() !== 'español'
        ? ` IMPORTANTE: el estudiante va a vender en un país donde se habla ${idioma} — redacta TODO directamente en ${idioma}, no en español.`
        : '';
    const notaPais = notaTonoPorPais(input.pais);

    const systemPrompt = anguloElegido
      ? `Eres un equipo experto compuesto por: especialista en eCommerce, copywriter senior de respuesta directa, especialista en Meta Ads y TikTok Ads, especialista en CRO (Conversion Rate Optimization), y diseñador de landing pages de alta conversión.

El usuario ya eligió el ángulo de venta con el que quiere seguir — no lo cambies ni lo reformules, tomalo tal cual viene. Tu tarea es, a partir de la ficha técnica del producto y de ESE ángulo puntual, redactar el resto de la estrategia de marketing, 100% coherente y específica con ese ángulo (nunca genérica).

Ángulo de venta elegido: "${anguloElegido}"

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después, sin bloques de markdown, con exactamente estas claves (todos los valores en ${idioma}, redactados con enfoque de copywriting persuasivo y de conversión, cada uno de 1 a 3 frases concretas):
{"problema":"...","avatar":"...","resultado":"...","solucion":"...","mecanismo":"..."}

Significado de cada clave:
- problema: el problema específico que resuelve ese ángulo y cómo lo vive el cliente hoy.
- avatar: el público objetivo ideal para ese ángulo (edad, intereses, comportamiento).
- resultado: el resultado final y transformación que el cliente busca con ese ángulo.
- solucion: por qué este producto es la solución ideal frente a otras alternativas (alternativas de PRODUCTO, ej. otras marcas o métodos caseros — nunca alternativas médicas, ver regla abajo).
- mecanismo: el mecanismo único o diferenciador frente a la competencia, coherente con ese ángulo.
${notaIdioma}${notaPais}

${REGLA_CONTENIDO}

${REGLA_ANTIEXAGERACION}

${REGLA_FORMATO_JSON}`
      : `Eres un equipo experto compuesto por: especialista en eCommerce, copywriter senior de respuesta directa, especialista en Meta Ads y TikTok Ads, especialista en CRO (Conversion Rate Optimization), y diseñador de landing pages de alta conversión.

Tu tarea es analizar la ficha técnica de un producto (de cualquier categoría: hogar, belleza, salud, fitness, mascotas, tecnología, moda, etc.) y construir una estrategia de marketing completa, específica para ese producto y nunca genérica.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después, sin bloques de markdown, con exactamente estas claves (todos los valores en ${idioma}, redactados con enfoque de copywriting persuasivo y de conversión, cada uno de 1 a 3 frases concretas):
{"angulo":"...","problema":"...","avatar":"...","resultado":"...","solucion":"...","mecanismo":"..."}

Significado de cada clave:
- angulo: el ángulo de venta principal con mayor potencial de conversión.
- problema: el problema específico que resuelve y cómo lo vive el cliente hoy.
- avatar: el público objetivo ideal (edad, intereses, comportamiento).
- resultado: el resultado final y transformación que el cliente busca.
- solucion: por qué este producto es la solución ideal frente a otras alternativas (alternativas de PRODUCTO, ej. otras marcas o métodos caseros — nunca alternativas médicas, ver regla abajo).
- mecanismo: el mecanismo único o diferenciador frente a la competencia.
${notaIdioma}${notaPais}

${REGLA_CONTENIDO}

${REGLA_ANTIEXAGERACION}

${REGLA_FORMATO_JSON}`;

    const userMsg = `Nombre del producto: ${input.nombreProducto}\n\nFicha técnica / detalles del producto:\n${input.detallesProducto}`;

    const datos = await this.llamarFal(input.falApiKey, userMsg, systemPrompt);

    if (anguloElegido) {
      // El modelo no devuelve "angulo" en este modo (ya lo sabíamos) — lo
      // completamos nosotros con el que eligió el usuario, tal cual.
      return { angulo: anguloElegido, ...datos } as GenerarCopyResultado;
    }
    return datos as GenerarCopyResultado;
  }

  // Pedido 11/09: sección "Testimonios" en modo Personalizada. El estudiante
  // sube una foto real y escribe el texto real que le mandó un cliente real
  // — esta llamada NUNCA redacta una reseña desde cero, solo pule la que ya
  // existe (ver la regla más importante del prompt, abajo) y le agrega un
  // nombre + ciudad genéricos según el país donde se vende.
  async adaptarResena(input: AdaptarResenaInput): Promise<AdaptarResenaResultado> {
    if (!input.falApiKey) {
      throw new InternalServerErrorException('Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.');
    }

    const idioma = (input.idioma || 'Español').trim() || 'Español';
    const notaIdioma =
      idioma.toLowerCase() !== 'español'
        ? ` IMPORTANTE: el estudiante vende en un país donde se habla ${idioma} — redactá el texto ya pulido de la reseña directamente en ${idioma}, no en español (el texto original que te paso puede venir en cualquier idioma).`
        : '';

    const paisLimpio = (input.pais || '').trim();
    const notaPais =
      paisLimpio && paisLimpio !== 'Selecciona el país'
        ? ` El país donde se vende este producto es ${paisLimpio} — el nombre y la ciudad que inventes tienen que sonar realmente típicos de ${paisLimpio}, nunca genéricos ni de otro país.`
        : ' No se especificó un país puntual para esta venta — usá un nombre y una ciudad neutros, comunes en Latinoamérica.';

    const nombresUsados = (input.nombresUsados || []).filter((n) => n && n.trim());
    const ciudadesUsadas = (input.ciudadesUsadas || []).filter((c) => c && c.trim());
    const notaRepetidos =
      (nombresUsados.length > 0 ? ` Nombres que YA se usaron en otras reseñas de esta misma landing y NO podés repetir: ${nombresUsados.join(', ')}.` : '') +
      (ciudadesUsadas.length > 0 ? ` Ciudades que YA se usaron — tratá de variar: ${ciudadesUsadas.join(', ')}.` : '');

    const systemPrompt = `Sos un editor de reseñas de clientes reales para una tienda de eCommerce.

Vas a recibir el texto EXACTO que un cliente real escribió sobre el producto "${input.nombreProducto}" después de haberlo comprado y usado. Tu única tarea es PULIR ese texto (corregir ortografía y gramática, acortarlo si es muy largo o repetitivo, darle un tono natural y creíble de reseña real) y agregarle un nombre + inicial de apellido y una ciudad genéricos para mostrar junto a la reseña.

REGLA MÁS IMPORTANTE DE TODAS (no negociable): NUNCA inventes ni agregues un resultado, beneficio, cifra, plazo o detalle que el cliente no haya mencionado en su texto original. Si el texto original es corto o simple, el resultado también puede quedar corto — es preferible una reseña corta y 100% real a una larga con contenido inventado. Sí está permitido: corregir ortografía/gramática, acortar si es repetitivo, reordenar mejor las ideas ya presentes. NO está permitido: agregar cifras, resultados, plazos o beneficios que el cliente no haya escrito.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después, sin bloques de markdown, con exactamente estas claves:
{"nombre":"...","ciudad":"...","estrellas":5,"texto":"..."}

Significado de cada clave:
- nombre: nombre de pila + inicial del apellido con punto, por ejemplo "Valentina R." (nunca el nombre completo del cliente real, por privacidad — este nombre es inventado).
- ciudad: una ciudad real y conocida del país indicado.
- estrellas: 5 la gran mayoría de las veces, o 4 si el texto original suena a una experiencia buena pero no perfecta (por ejemplo, si menciona alguna duda inicial). Nunca menos de 4 — no se publican reseñas negativas.
- texto: el texto ya pulido, de 1 a 3 frases, tono cercano y natural, en primera persona, 100% coherente con lo que el cliente realmente escribió (ver la regla más importante, arriba).
${notaIdioma}${notaPais}${notaRepetidos}

${REGLA_ANTIEXAGERACION}

${REGLA_FORMATO_JSON}`;

    const userMsg = `Texto real que escribió el cliente:\n${input.textoOriginal}`;

    const datos = await this.llamarFal(input.falApiKey, userMsg, systemPrompt);
    const estrellasNum = Math.min(5, Math.max(4, Math.round(Number(datos?.estrellas) || 5)));
    return {
      nombre: String(datos?.nombre || '').trim() || 'Cliente V.',
      ciudad: String(datos?.ciudad || '').trim(),
      estrellas: estrellasNum,
      texto: String(datos?.texto || input.textoOriginal || '').trim(),
    };
  }

  // Pedido 11/09 (pivote): reemplaza en la práctica a adaptarResena() para
  // el flujo nuevo — el estudiante solo sube una foto real de una persona,
  // sin escribir ningún texto, y la IA "mira" la foto (modelo con visión,
  // ver llamarFalVision()) y redacta una reseña creíble inspirada en lo que
  // se ve. adaptarResena() queda en el código sin usar por si se necesita
  // volver al flujo viejo, pero el taller ya no la llama.
  async generarResenaDesdeFoto(input: GenerarResenaDesdeFotoInput): Promise<AdaptarResenaResultado> {
    if (!input.falApiKey) {
      throw new InternalServerErrorException('Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.');
    }
    if (!input.fotoUrl) {
      throw new InternalServerErrorException('Falta la foto de la reseña.');
    }

    const idioma = (input.idioma || 'Español').trim() || 'Español';
    const notaIdioma =
      idioma.toLowerCase() !== 'español'
        ? ` IMPORTANTE: el estudiante vende en un país donde se habla ${idioma} — redactá el texto de la reseña directamente en ${idioma}, no en español.`
        : '';

    const paisLimpio = (input.pais || '').trim();
    const notaPais =
      paisLimpio && paisLimpio !== 'Selecciona el país'
        ? ` El país donde se vende este producto es ${paisLimpio} — el nombre y la ciudad que inventes tienen que sonar realmente típicos de ${paisLimpio}, nunca genéricos ni de otro país.`
        : ' No se especificó un país puntual para esta venta — usá un nombre y una ciudad neutros, comunes en Latinoamérica.';

    const nombresUsados = (input.nombresUsados || []).filter((n) => n && n.trim());
    const ciudadesUsadas = (input.ciudadesUsadas || []).filter((c) => c && c.trim());
    const notaRepetidos =
      (nombresUsados.length > 0 ? ` Nombres que YA se usaron en otras reseñas de esta misma landing y NO podés repetir: ${nombresUsados.join(', ')}.` : '') +
      (ciudadesUsadas.length > 0 ? ` Ciudades que YA se usaron — tratá de variar: ${ciudadesUsadas.join(', ')}.` : '');

    const systemPrompt = `Sos un redactor de reseñas de clientes para una tienda de eCommerce.

Vas a recibir UNA foto real de una persona (subida por el vendedor del producto "${input.nombreProducto}"). Tu tarea es imaginar que esa persona es clienta/cliente real que ya compró y usó el producto, y escribir en su nombre una reseña corta, natural y creíble, como si la hubiera escrito ella misma después de recibir el producto.

REGLA MÁS IMPORTANTE DE TODAS (no negociable, es un tema de privacidad): NUNCA intentes reconocer, adivinar o mencionar la identidad real de la persona de la foto (no es una persona famosa para esta tarea, aunque se parezca a alguien) — el nombre que pongas siempre es inventado por vos, nunca una suposición sobre quién es realmente. Tampoco describas ni menciones la foto ni el aspecto físico de la persona dentro del texto de la reseña (la reseña habla del producto, no de la foto).

Fijate también, con cuidado, en el contexto visible de la foto (por ejemplo: si se ve el producto en uso, el ambiente, la expresión de la persona, si parece una foto casera de celular) para que el tono y el contenido de la reseña se sientan coherentes con esa imagen — pero sin inventar resultados médicos, cifras exactas, plazos concretos o beneficios medibles que no se puedan justificar con una simple opinión de cliente contento.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después, sin bloques de markdown, con exactamente estas claves:
{"nombre":"...","ciudad":"...","estrellas":5,"texto":"..."}

Significado de cada clave:
- nombre: nombre de pila + inicial del apellido con punto, por ejemplo "Valentina R." (inventado, no un intento de adivinar el nombre real de la persona de la foto).
- ciudad: una ciudad real y conocida del país indicado.
- estrellas: 5 la gran mayoría de las veces, o 4 alguna vez para que no todas sean perfectas. Nunca menos de 4 — no se publican reseñas negativas.
- texto: la reseña en primera persona, de 1 a 3 frases, tono cercano y natural de cliente real y contento, sin sonar a publicidad.
${notaIdioma}${notaPais}${notaRepetidos}

${REGLA_ANTIEXAGERACION}

${REGLA_FORMATO_JSON}`;

    const userMsg = `Escribí la reseña mirando la foto adjunta del producto "${input.nombreProducto}".`;

    const datos = await this.llamarFalVision(input.falApiKey, input.fotoUrl, userMsg, systemPrompt);
    const estrellasNum = Math.min(5, Math.max(4, Math.round(Number(datos?.estrellas) || 5)));
    return {
      nombre: String(datos?.nombre || '').trim() || 'Cliente V.',
      ciudad: String(datos?.ciudad || '').trim(),
      estrellas: estrellasNum,
      texto: String(datos?.texto || '').trim(),
    };
  }

  // Pedido 11/09 (versión final): reemplaza en la práctica a
  // generarResenaDesdeFoto() — ya no mira ninguna foto, solo inventa una
  // reseña creíble de texto a partir del nombre del producto, el país y el
  // idioma. El avatar y la foto de la reseña se resuelven aparte (ver la
  // nota grande en GenerarTextoResenaInput, arriba).
  async generarTextoResena(input: GenerarTextoResenaInput): Promise<AdaptarResenaResultado> {
    if (!input.falApiKey) {
      throw new InternalServerErrorException('Todavía no conectaste tu clave de fal.ai. Andá a "Integraciones" y conectala primero.');
    }

    const idioma = (input.idioma || 'Español').trim() || 'Español';
    const notaIdioma =
      idioma.toLowerCase() !== 'español'
        ? ` IMPORTANTE: el estudiante vende en un país donde se habla ${idioma} — redactá el texto de la reseña directamente en ${idioma}, no en español.`
        : '';

    const paisLimpio = (input.pais || '').trim();
    const notaPais =
      paisLimpio && paisLimpio !== 'Selecciona el país'
        ? ` El país donde se vende este producto es ${paisLimpio} — el nombre y la ciudad que inventes tienen que sonar realmente típicos de ${paisLimpio}, nunca genéricos ni de otro país.`
        : ' No se especificó un país puntual para esta venta — usá un nombre y una ciudad neutros, comunes en Latinoamérica.';

    const nombresUsados = (input.nombresUsados || []).filter((n) => n && n.trim());
    const ciudadesUsadas = (input.ciudadesUsadas || []).filter((c) => c && c.trim());
    const textosUsados = (input.textosUsados || []).filter((t) => t && t.trim());
    const notaRepetidos =
      (nombresUsados.length > 0 ? ` Nombres que YA se usaron en otras reseñas de esta misma landing y NO podés repetir: ${nombresUsados.join(', ')}.` : '') +
      (ciudadesUsadas.length > 0 ? ` Ciudades que YA se usaron — tratá de variar: ${ciudadesUsadas.join(', ')}.` : '');

    // Ver el comentario grande junto a ENFOQUES_RESENA (arriba): la variedad
    // de contenido entre reseñas queda garantizada asignando un enfoque fijo
    // según la posición de esta reseña en la lista, no dejada al azar.
    const indice = Number.isInteger(input.indice) && (input.indice as number) >= 0 ? (input.indice as number) : 0;
    const enfoque = ENFOQUES_RESENA[indice % ENFOQUES_RESENA.length];
    const notaTextosUsados =
      textosUsados.length > 0
        ? `\n\nEstos son los textos EXACTOS de otras reseñas que YA se escribieron para este mismo producto — tu reseña nueva tiene que ser CLARAMENTE distinta a todas estas, no solo cambiando un par de palabras sueltas dentro de la misma frase: tiene que tener una idea, un arranque y una forma de contarlo diferente.\n${textosUsados.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`
        : '';

    // Pedido 12/09 (bug reportado por Norbey): el avatar (la foto/carita) de
    // esta MISMA reseña ya se generó como una persona de este sexo puntual —
    // el nombre que invente el modelo tiene que ser inequívocamente de ese
    // mismo sexo, nunca ambiguo ni del otro, para que no quede una foto de
    // hombre con nombre de mujer (o al revés).
    const sexoLimpio = (input.sexo || '').trim();
    const notaSexo =
      sexoLimpio === 'Hombre'
        ? ' El nombre que inventes tiene que ser un nombre de HOMBRE, inequívocamente masculino (nunca un nombre de mujer ni un nombre unisex/ambiguo).'
        : sexoLimpio === 'Mujer'
          ? ' El nombre que inventes tiene que ser un nombre de MUJER, inequívocamente femenino (nunca un nombre de hombre ni un nombre unisex/ambiguo).'
          : '';

    const systemPrompt = `Sos un redactor de reseñas de clientes para una tienda de eCommerce.

Tu tarea es inventar una reseña corta, natural y creíble de un cliente contento que ya compró y usó el producto "${input.nombreProducto}" — como si la hubiera escrito él mismo después de recibirlo.

REGLA DE VARIEDAD (no negociable, es la parte más importante de esta tarea): las reseñas de una misma landing NUNCA pueden sonar como la misma plantilla con palabras cambiadas — eso delata al toque que son fabricadas. Para ESTA reseña puntual, el enfoque/ángulo tiene que ser este: ${enfoque} No empieces la frase con "Llevo [tiempo] usando/tomando..." salvo que sea realmente el único enfoque que tenga sentido — variá también cómo arranca cada reseña (con el resultado, con una anécdota, con la persona, con una comparación, etc., según el enfoque de arriba).${notaTextosUsados}

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después, sin bloques de markdown, con exactamente estas claves:
{"nombre":"...","ciudad":"...","estrellas":5,"texto":"..."}

Significado de cada clave:
- nombre: nombre de pila + inicial del apellido con punto, por ejemplo "Valentina R." (inventado).${notaSexo}
- ciudad: una ciudad real y conocida del país indicado.
- estrellas: 5 la gran mayoría de las veces, o 4 alguna vez para que no todas sean perfectas. Nunca menos de 4 — no se publican reseñas negativas.
- texto: la reseña en primera persona, de 1 a 3 frases, tono cercano y natural de cliente real y contento, sin sonar a publicidad, siguiendo el enfoque asignado arriba.
${notaIdioma}${notaPais}${notaRepetidos}

${REGLA_ANTIEXAGERACION}

${REGLA_FORMATO_JSON}`;

    const userMsg = `Inventá la reseña para el producto "${input.nombreProducto}".`;

    const datos = await this.llamarFal(input.falApiKey, userMsg, systemPrompt);
    const estrellasNum = Math.min(5, Math.max(4, Math.round(Number(datos?.estrellas) || 5)));
    return {
      nombre: String(datos?.nombre || '').trim() || 'Cliente V.',
      ciudad: String(datos?.ciudad || '').trim(),
      estrellas: estrellasNum,
      texto: String(datos?.texto || '').trim(),
    };
  }

  // Llamada compartida a fal.ai (fal-ai/any-llm) que arma el mensaje,
  // maneja los errores comunes (clave inválida / sin crédito / sin
  // conexión) y devuelve el JSON ya parseado — usada tanto por
  // generarAngulos() como por generarCopy() para no repetir esta lógica.
  private async llamarFal(falApiKey: string, userMsg: string, systemPrompt: string): Promise<any> {
    const falClient = createFalClient({ credentials: falApiKey });

    let resultado;
    try {
      resultado = await falClient.subscribe('fal-ai/any-llm', {
        input: {
          model: MODELO_TEXTO,
          prompt: userMsg,
          system_prompt: systemPrompt,
          max_tokens: 1000,
          temperature: 0.7,
        },
        logs: false,
      });
    } catch (error) {
      if (this.esErrorDeClaveFalInvalida(error)) {
        throw new InternalServerErrorException(
          'fal.ai rechazó tu clave — revisá que la hayas pegado completa en "Integraciones" y que tengas créditos cargados en tu cuenta de fal.ai.',
        );
      }
      throw new InternalServerErrorException('No se pudo contactar a fal.ai: ' + this.extraerDetalleError(error));
    }

    return this.parsearRespuestaJson(resultado);
  }

  // Pedido 11/09: mismo patrón que llamarFal() pero contra el endpoint de
  // fal.ai con VISIÓN ("openrouter/router/vision" — distinto del texto-solo
  // "fal-ai/any-llm" de arriba), para poder mandarle una foto además del
  // texto del prompt. Usa la misma clave de fal.ai del usuario y el mismo
  // modelo (Claude vía OpenRouter) — no hace falta ninguna clave nueva.
  private async llamarFalVision(falApiKey: string, imageUrl: string, userMsg: string, systemPrompt: string): Promise<any> {
    const falClient = createFalClient({ credentials: falApiKey });

    let resultado;
    try {
      resultado = await falClient.subscribe('openrouter/router/vision', {
        input: {
          model: MODELO_TEXTO,
          prompt: userMsg,
          system_prompt: systemPrompt,
          image_urls: [imageUrl],
          max_tokens: 500,
          temperature: 0.9,
        },
        logs: false,
      });
    } catch (error) {
      if (this.esErrorDeClaveFalInvalida(error)) {
        throw new InternalServerErrorException(
          'fal.ai rechazó tu clave — revisá que la hayas pegado completa en "Integraciones" y que tengas créditos cargados en tu cuenta de fal.ai.',
        );
      }
      throw new InternalServerErrorException('No se pudo contactar a fal.ai: ' + this.extraerDetalleError(error));
    }

    return this.parsearRespuestaJson(resultado);
  }

  // Parte común a llamarFal() y llamarFalVision(): ambos endpoints de fal.ai
  // devuelven el texto generado en la misma forma (resultado.data.output) —
  // acá se limpia el posible cerco de markdown y se parsea el JSON.
  private parsearRespuestaJson(resultado: any): any {
    const texto = (resultado?.data as any)?.output;
    if (!texto || typeof texto !== 'string') {
      throw new InternalServerErrorException('La respuesta de fal.ai no incluyó texto.');
    }

    const clean = texto
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();

    try {
      return JSON.parse(clean);
    } catch {
      throw new InternalServerErrorException('La respuesta de fal.ai no fue un JSON válido.');
    }
  }

  // Sacar el detalle real del error de fal.ai (no solo "Unprocessable
  // Entity" genérico) — el SDK de fal suele traer el motivo exacto en
  // error.body.detail (mismo patrón que usa image-edit.service.ts).
  private extraerDetalleError(error: unknown): string {
    const err = error as any;
    return (
      (Array.isArray(err?.body?.detail)
        ? err.body.detail.map((d: any) => d.msg || JSON.stringify(d)).join('; ')
        : err?.body?.detail) ||
      err?.message ||
      String(error)
    );
  }

  private esErrorDeClaveFalInvalida(error: unknown): boolean {
    const status = (error as any)?.status;
    return status === 401 || status === 403;
  }
}
