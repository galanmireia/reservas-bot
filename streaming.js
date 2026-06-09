const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const twilio = require('twilio');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const ELEVENLABS_VOICE_ID = 'uQw4jpKzMLrZuo0RLPS9';

async function enviarAudioStreaming(text, ws, streamSid, setBotHablando) {
  if (!text || ws.readyState !== WebSocket.OPEN) return;

  try {
    const response = await elevenlabs.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.85, similarity_boost: 0.9, style: 0, use_speaker_boost: true },
      output_format: 'ulaw_8000'
    });

    const chunks = [];
    if (response[Symbol.asyncIterator]) {
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
    } else if (response.pipe) {
      await new Promise((resolve, reject) => {
        response.on('data', c => chunks.push(c));
        response.on('end', resolve);
        response.on('error', reject);
      });
    } else {
      chunks.push(Buffer.from(await response.arrayBuffer()));
    }

    if (chunks.length === 0 || ws.readyState !== WebSocket.OPEN) return;

    const audioBase64 = Buffer.concat(chunks).toString('base64');
    ws.send(JSON.stringify({ event: 'clear', streamSid }));
    setBotHablando(true);
    ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: audioBase64 } }));
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'fin' } }));
  } catch (err) {
    console.error('Error ElevenLabs:', err.message);
  }
}

function fechaHoyMadrid() {
  const ahora = new Date();
  const iso = ahora.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const diaNombre = ahora.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long' });
  const fechaLarga = ahora.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return { iso, diaNombre, fechaLarga };
}

// Cuelga la llamada vía Twilio REST API
async function colgarLlamada(callSid) {
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.calls(callSid).update({ status: 'completed' });
    console.log('Llamada colgada:', callSid);
  } catch (err) {
    console.error('Error colgando llamada:', err.message);
  }
}

// GPT devuelve JSON con: respuesta (voz), datos (reserva opcional), colgar (boolean)
// Una sola llamada GPT = respuesta conversacional + extracción + señal de colgar
function buildCallSystemPrompt(baseContent, hoy) {
  return baseContent + `

FORMATO DE RESPUESTA OBLIGATORIO PARA LLAMADAS:
Responde SIEMPRE únicamente con JSON válido, sin texto fuera del JSON:
{"respuesta": "lo que dices en voz alta", "datos": null, "colgar": false}

FLUJO DE CANCELACIÓN Y MODIFICACIÓN (OBLIGATORIO, sigue estos pasos en orden):
1. Pregunta: "¿A nombre de quién está la reserva?"
2. Con el nombre, manda datos: {"accion": "CONSULTAR", "nombre": "X"} — el sistema te devuelve la lista con fechas entre corchetes [YYYY-MM-DD].
3. Lee la lista al cliente en voz natural (NO digas los corchetes, son solo para ti). Si hay varias, pregunta cuál quiere.
4. Cuando el cliente elija, pregunta: "¿Confirmas que quieres cancelar la reserva del [fecha hablada]?"
5. Solo cuando diga SÍ: manda CANCELAR con el nombre exacto de la lista Y la fecha exacta del corchete [YYYY-MM-DD].

REGLAS CRÍTICAS PARA CANCELAR:
- NUNCA mandes CANCELAR sin haber hecho CONSULTAR antes.
- NUNCA mandes CANCELAR sin incluir TANTO nombre COMO fecha (ambos obligatorios).
- La fecha en CANCELAR debe ser exactamente la que aparece entre corchetes en la lista del sistema, en formato YYYY-MM-DD.
- Si el cliente no ha confirmado explícitamente, NO mandes CANCELAR todavía.

CUÁNDO PONER colgar: true:
Cuando el cliente se despida, diga adiós, gracias y ya está, o no quiera nada más. Antes de colgar despídete brevemente.

CUÁNDO INCLUIR datos:
- NUEVA: nombre, fecha, hora, personas (todos obligatorios)
- CANCELAR: nombre (del listado) + fecha en YYYY-MM-DD (ambos obligatorios, tomados del resultado de CONSULTAR)
- MODIFICAR: nombre + fecha actual (del listado) + al menos un dato nuevo (nueva_fecha, nueva_hora o nuevas_personas)
- CONSULTAR: solo nombre
- ESPERA / DISPONIBILIDAD: con los datos disponibles

Ejemplos:

Nueva reserva confirmada:
{"respuesta": "Un momento, lo proceso.", "datos": {"accion": "NUEVA", "nombre": "Pedro", "fecha": "YYYY-MM-DD", "hora": "HH:MM", "personas": 2, "notas": null, "nueva_fecha": null, "nueva_hora": null, "nuevas_personas": null}, "colgar": false}

Consultar reservas de un nombre (paso previo a cancelar/modificar):
{"respuesta": "Un momento, busco.", "datos": {"accion": "CONSULTAR", "nombre": "Pedro", "fecha": null, "hora": null, "personas": null, "notas": null, "nueva_fecha": null, "nueva_hora": null, "nuevas_personas": null}, "colgar": false}

Cancelación (una vez el cliente ha elegido cuál de la lista):
{"respuesta": "Un momento, lo cancelo.", "datos": {"accion": "CANCELAR", "nombre": "Pedro", "fecha": "YYYY-MM-DD", "hora": null, "personas": null, "notas": null, "nueva_fecha": null, "nueva_hora": null, "nuevas_personas": null}, "colgar": false}

Modificación (una vez el cliente ha elegido cuál y dado los nuevos datos):
{"respuesta": "Un momento, lo cambio.", "datos": {"accion": "MODIFICAR", "nombre": "Pedro", "fecha": "YYYY-MM-DD", "hora": null, "personas": null, "notas": null, "nueva_fecha": "YYYY-MM-DD", "nueva_hora": "HH:MM", "nuevas_personas": null}, "colgar": false}

HOY es ${hoy.diaNombre} ${hoy.iso} (${hoy.fechaLarga}). Úsalo para calcular "mañana", "este viernes", etc.
El campo nombre es el nombre PARA LA RESERVA, no el del teléfono. Si dice "a nombre de X", nombre es X.
Si faltan datos, "datos" es null y "respuesta" es la pregunta al cliente.`;
}

async function guardarTranscripcion(db, callSid, usuarioId, telefono, lineas, inicioLlamada) {
  if (!db || !callSid || lineas.length === 0) return;
  try {
    const transcript = lineas.join('\n');
    const duracion = inicioLlamada ? Math.floor((Date.now() - inicioLlamada) / 1000) : null;
    await db.query(
      'INSERT INTO transcripciones (call_sid, usuario_id, telefono, transcript, duracion_seg) VALUES ($1,$2,$3,$4,$5)',
      [callSid, usuarioId, telefono, transcript, duracion]
    );
    console.log('Transcripción guardada:', callSid);
  } catch (err) {
    console.error('Error guardando transcripción:', err.message);
  }
}

function setupMediaStreamWebSocket(wss, openai, db, procesarAccion, obtenerContextoCliente, obtenerUsuarioPorNumero, obtenerConfigRestaurante, SYSTEM_PROMPT) {
  wss.on('connection', (ws) => {
    console.log('Media Stream WebSocket conectado');

    let streamSid = null;
    let callSid = null;
    let telefonoCliente = null;
    let deepgramLive = null;
    let conversacion = [];
    let usuarioId = null;
    let config = null;
    let transcripcionBuffer = '';
    let procesando = false;
    let botHablando = false;
    let pendingHangup = false;
    let lineasTranscript = [];
    let inicioLlamada = null;
    let deepgramReconnecting = false;
    let deepgramRetries = 0;

    async function enviarAudio(texto) {
      await enviarAudioStreaming(texto, ws, streamSid, (v) => { botHablando = v; });
    }

    async function iniciarDeepgram(esReconexion = false) {
      deepgramLive = deepgramClient.listen.live({
        model: 'nova-2',
        language: 'es',
        smart_format: true,
        numerals: true,
        encoding: 'mulaw',
        sample_rate: 8000,
        channels: 1,
        interim_results: true,
        utterance_end_ms: 1000,
        vad_events: true
      });

      deepgramLive.on(LiveTranscriptionEvents.Open, () => {
        console.log(esReconexion ? 'Deepgram reconectado' : 'Deepgram conectado');
        deepgramReconnecting = false;
        deepgramRetries = 0;
      });

      deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript || transcript.trim().length < 2) return;

        // BARGE-IN: cliente habla mientras el bot está hablando
        if (botHablando && data.is_final) {
          console.log('Interrupción detectada:', transcript);
          ws.send(JSON.stringify({ event: 'clear', streamSid })); // para el audio del bot
          botHablando = false;
          pendingHangup = false;
          transcripcionBuffer = transcript.trim(); // empezar con lo que dijo
          return;
        }

        if (botHablando) return;

        if (data.is_final) {
          transcripcionBuffer += ' ' + transcript;
          transcripcionBuffer = transcripcionBuffer.trim();
          console.log('Transcripcion final:', transcripcionBuffer);
          lineasTranscript.push(`Cliente: ${transcript.trim()}`);
        }
      });

      deepgramLive.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
        if (!transcripcionBuffer || procesando || botHablando) return;
        const textoCliente = transcripcionBuffer.trim();
        transcripcionBuffer = '';
        procesando = true;

        console.log('Cliente dijo:', textoCliente);

        try {
          conversacion.push({ role: 'user', content: textoCliente });

          // Una sola llamada GPT: respuesta + datos opcionales + señal de colgar
          const respuestaIA = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 250,
            response_format: { type: 'json_object' },
            messages: conversacion
          });

          let parsed;
          try {
            parsed = JSON.parse(respuestaIA.choices[0].message.content);
          } catch {
            parsed = { respuesta: respuestaIA.choices[0].message.content, datos: null, colgar: false };
          }

          let mensaje = parsed.respuesta || 'Un momento.';
          conversacion.push({ role: 'assistant', content: mensaje });
          console.log('Respuesta IA:', mensaje, parsed.datos ? '| datos: ' + JSON.stringify(parsed.datos) : '', parsed.colgar ? '| COLGAR' : '');
          lineasTranscript.push(`Bot: ${mensaje}`);

          // Procesar acción si GPT ya tiene los datos (sin segunda llamada GPT)
          if (parsed.datos && parsed.datos.accion) {
            try {
              console.log('Datos extraidos:', JSON.stringify(parsed.datos));
              const contexto = await obtenerContextoCliente(telefonoCliente || callSid);
              mensaje = await procesarAccion(parsed.datos, callSid, contexto, telefonoCliente || callSid, usuarioId, config);
              console.log('Respuesta procesarAccion:', mensaje);

              const esFinal = mensaje.includes('confirmada') || mensaje.includes('cancelada') || mensaje.includes('modificada') || mensaje.includes('te he apuntado en la lista de espera');

              if (esFinal) {
                // Acción completada: resetear conversación con el nuevo contexto
                const nuevoContexto = await obtenerContextoCliente(telefonoCliente || callSid);
                const hoy = fechaHoyMadrid();
                conversacion = [
                  { role: 'system', content: buildCallSystemPrompt(SYSTEM_PROMPT(hoy.iso, nuevoContexto, config), hoy) },
                  { role: 'assistant', content: mensaje }
                ];
              } else {
                // Acción intermedia (CONSULTAR, etc.): actualizar el último mensaje del asistente
                // con el resultado real para que GPT tenga contexto en el siguiente turno
                if (conversacion.length > 0 && conversacion[conversacion.length - 1].role === 'assistant') {
                  conversacion[conversacion.length - 1].content = mensaje;
                } else {
                  conversacion.push({ role: 'assistant', content: mensaje });
                }
              }
            } catch (err) {
              console.error('Error procesarAccion:', err.message);
              mensaje = 'Tu reserva ha sido procesada. Te esperamos!';
            }
          }

          // Marcar que hay que colgar cuando termine el audio
          if (parsed.colgar) pendingHangup = true;

          await enviarAudio(mensaje);
        } catch (err) {
          console.error('Error procesando:', err.message);
        } finally {
          procesando = false;
        }
      });

      deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
        console.error('Error Deepgram:', err);
      });

      deepgramLive.on(LiveTranscriptionEvents.Close, () => {
        if (deepgramReconnecting || deepgramRetries >= 3 || ws.readyState !== WebSocket.OPEN) return;
        deepgramRetries++;
        deepgramReconnecting = true;
        const delay = deepgramRetries * 1000;
        console.log(`Deepgram cerrado inesperadamente. Reconectando en ${delay}ms (intento ${deepgramRetries})...`);
        setTimeout(async () => {
          try {
            await iniciarDeepgram(true);
          } catch (e) {
            console.error('Error reconectando Deepgram:', e.message);
            deepgramReconnecting = false;
          }
        }, delay);
      });
    }

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'connected':
            console.log('Media stream connected');
            break;

          case 'start':
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;
            const fromRaw = data.start.customParameters?.from || data.start.customParameters?.From || null;
            telefonoCliente = fromRaw ? fromRaw.replace('whatsapp:', '') : callSid;
            console.log('Stream iniciado:', streamSid, callSid, 'tel:', telefonoCliente);

            usuarioId = await obtenerUsuarioPorNumero(data.start.customParameters?.to || data.start.customParameters?.To || null);
            config = usuarioId ? await obtenerConfigRestaurante(usuarioId) : null;

            const hoy = fechaHoyMadrid();
            conversacion = [{ role: 'system', content: buildCallSystemPrompt(SYSTEM_PROMPT(hoy.iso, { cliente: null, reservas: [] }, config), hoy) }];

            inicioLlamada = Date.now();
            await iniciarDeepgram();

            const nombreBot = config?.nombre_bot?.trim() || 'Laura';
            const nombreRest = config?.restaurante?.trim() || 'el restaurante';
            const saludoTexto = `Hola, soy ${nombreBot}, la asistente de ${nombreRest}. ¿En qué puedo ayudarte?`;
            conversacion.push({ role: 'assistant', content: saludoTexto });
            lineasTranscript.push(`Bot: ${saludoTexto}`);
            await enviarAudio(saludoTexto);
            break;

          case 'media':
            if (deepgramLive && deepgramLive.getReadyState() === 1) {
              deepgramLive.send(Buffer.from(data.media.payload, 'base64'));
            }
            break;

          case 'mark':
            // Twilio confirma que terminó de reproducir el audio
            if (data.mark?.name === 'fin') {
              botHablando = false;
              transcripcionBuffer = '';
              console.log('Bot terminó de hablar');

              // Si GPT indicó colgar, colgamos ahora que el audio terminó
              if (pendingHangup && callSid) {
                pendingHangup = false;
                setTimeout(() => colgarLlamada(callSid), 600); // pequeño buffer
              }
            }
            break;

          case 'stop':
            console.log('Stream parado');
            if (deepgramLive) deepgramLive.finish();
            await guardarTranscripcion(db, callSid, usuarioId, telefonoCliente, lineasTranscript, inicioLlamada);
            break;
        }
      } catch (err) {
        console.error('Error en WebSocket:', err.message);
      }
    });

    ws.on('close', async () => {
      console.log('Media Stream WebSocket desconectado');
      if (deepgramLive) { deepgramLive.finish(); deepgramReconnecting = true; }
      if (lineasTranscript.length > 0) {
        await guardarTranscripcion(db, callSid, usuarioId, telefonoCliente, lineasTranscript, inicioLlamada);
      }
    });
  });
}

module.exports = { setupMediaStreamWebSocket };
