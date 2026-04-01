const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { ElevenLabsClient } = require('elevenlabs');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const ELEVENLABS_VOICE_ID = 'uQw4jpKzMLrZuo0RLPS9';

async function textToSpeechStream(text) {
  try {
    const response = await elevenlabs.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      text,
      model_id: 'eleven_turbo_v2_5',
     voice_settings: { stability: 0.8, similarity_boost: 0.85, style: 0, use_speaker_boost: true },
      output_format: 'ulaw_8000'
    });

    const chunks = [];
    if (response[Symbol.asyncIterator]) {
      for await (const chunk of response) {
        chunks.push(chunk);
      }
    } else if (response.pipe) {
      await new Promise((resolve, reject) => {
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', resolve);
        response.on('error', reject);
      });
    } else {
      chunks.push(Buffer.from(await response.arrayBuffer()));
    }
    return Buffer.concat(chunks).toString('base64');
  } catch (err) {
    console.error('Error ElevenLabs streaming:', err.message);
    return null;
  }
}

function setupMediaStreamWebSocket(wss, openai, db, procesarAccion, obtenerContextoCliente, obtenerUsuarioPorNumero, obtenerConfigRestaurante, SYSTEM_PROMPT) {
  wss.on('connection', (ws) => {
    console.log('Media Stream WebSocket conectado');

    let streamSid = null;
    let callSid = null;
    let deepgramLive = null;
    let conversacion = [];
    let usuarioId = null;
    let config = null;
    let transcripcionBuffer = '';
    let procesando = false;

    async function iniciarDeepgram() {
      deepgramLive = deepgramClient.listen.live({
        model: 'nova-2',
        language: 'es',
        smart_format: true,
        encoding: 'mulaw',
        sample_rate: 8000,
        channels: 1,
        interim_results: true,
        utterance_end_ms: 1000,
        vad_events: true
      });

      deepgramLive.on(LiveTranscriptionEvents.Open, () => {
        console.log('Deepgram conectado');
      });

      deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (!transcript) return;

        if (data.is_final) {
          transcripcionBuffer += ' ' + transcript;
          transcripcionBuffer = transcripcionBuffer.trim();
          console.log('Transcripcion final:', transcripcionBuffer);
        }
      });

      deepgramLive.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
        if (!transcripcionBuffer || procesando) return;
        const textoCliente = transcripcionBuffer.trim();
        transcripcionBuffer = '';
        procesando = true;

        console.log('Cliente dijo:', textoCliente);

        try {
          conversacion.push({ role: 'user', content: textoCliente });

          const respuestaIA = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 150,
            messages: conversacion
          });

          let mensaje = respuestaIA.choices[0].message.content;
          conversacion.push({ role: 'assistant', content: mensaje });
          console.log('Respuesta IA:', mensaje);

          if (mensaje.toLowerCase().includes('un momento por favor')) {
            const { extraerDatosReserva } = require('./index');
            // procesamos accion
            try {
              const datos = await extraerDatosReservaLocal(conversacion, openai);
              const contexto = { cliente: null, reservas: [] };
              mensaje = await procesarAccion(datos, callSid, contexto, callSid, usuarioId, config);
            } catch (err) {
              console.error('Error procesarAccion:', err.message);
              mensaje = 'Tu reserva ha sido procesada. Te esperamos!';
            }
          }

          const audioBase64 = await textToSpeechStream(mensaje);
          if (audioBase64 && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: audioBase64 }
            }));
            ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'fin' } }));
          }
        } catch (err) {
          console.error('Error procesando:', err.message);
        } finally {
          procesando = false;
        }
      });

      deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
        console.error('Error Deepgram:', err);
      });
    }

    async function extraerDatosReservaLocal(mensajes, openai) {
      const respuesta = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          ...mensajes,
          { role: 'user', content: `Extrae los datos en formato JSON con estos campos: accion (NUEVA, CANCELAR, MODIFICAR, CONSULTAR, ESPERA o DISPONIBILIDAD), nombre, fecha, hora, personas, notas, nueva_fecha, nueva_hora, nuevas_personas. La fecha en formato YYYY-MM-DD, hoy es ${new Date().toISOString().split('T')[0]}. La hora en HH:MM. Si falta un dato pon null. Solo JSON sin texto adicional.` }
        ]
      });
      const texto = respuesta.choices[0].message.content.replace(/```json|```/g, '').trim();
      return JSON.parse(texto);
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
            console.log('Stream iniciado:', streamSid, callSid);

            usuarioId = await obtenerUsuarioPorNumero(data.start.customParameters?.to || null);
            config = usuarioId ? await obtenerConfigRestaurante(usuarioId) : null;

            const hoy = new Date().toISOString().split('T')[0];
            conversacion = [{ role: 'system', content: SYSTEM_PROMPT(hoy, { cliente: null, reservas: [] }, config) }];

            await iniciarDeepgram();

            const saludoTexto = 'Hola, soy Laura, la asistente del restaurante. ¿En qué puedo ayudarte?';
            conversacion.push({ role: 'assistant', content: saludoTexto });

            const saludoAudio = await textToSpeechStream(saludoTexto);
            if (saludoAudio && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: saludoAudio }
              }));
            }
            break;

          case 'media':
            if (deepgramLive && deepgramLive.getReadyState() === 1) {
              const audioBuffer = Buffer.from(data.media.payload, 'base64');
              deepgramLive.send(audioBuffer);
            }
            break;

          case 'stop':
            console.log('Stream parado');
            if (deepgramLive) deepgramLive.finish();
            break;
        }
      } catch (err) {
        console.error('Error en WebSocket:', err.message);
      }
    });

    ws.on('close', () => {
      console.log('Media Stream WebSocket desconectado');
      if (deepgramLive) deepgramLive.finish();
    });
  });
}

module.exports = { setupMediaStreamWebSocket };