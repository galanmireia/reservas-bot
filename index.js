require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const bcrypt = require('bcrypt');
const session = require('express-session');
const cron = require('node-cron');

const TEST_MODE = process.env.TEST_MODE === 'true';
const stubs = TEST_MODE ? require('./test/stubs') : null;
if (TEST_MODE) console.log('⚠️  TEST_MODE activo — APIs externas mockeadas, no se cobra nada.');

const { Resend } = require('resend');
const resend = stubs?.resend || new Resend(process.env.RESEND_API_KEY);
const { ElevenLabsClient } = require('elevenlabs');
const elevenlabs = stubs?.elevenlabs || new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const ELEVENLABS_ENABLED = process.env.ELEVENLABS_ENABLED === 'true';
const ELEVENLABS_VOICE_ID = 'uQw4jpKzMLrZuo0RLPS9';

const OpenAI = require('openai');
const openai = stubs?.openai || new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let db;
if (stubs?.db) {
  db = stubs.db;
} else {
  const { Pool } = require('pg');
  db = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
  });
}

const twilioLib = require('twilio');
const twilioClient = stubs?.twilioClient || twilioLib(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversaciones = {};
const conversacionesWhatsapp = {};

const SESSION_SECRET = process.env.SESSION_SECRET || (TEST_MODE ? 'test-only-secret-do-not-use-in-prod' : null);
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET es obligatorio. Definilo en el entorno o usá TEST_MODE=true para pruebas.');
}
const IS_PROD = process.env.NODE_ENV === 'production';
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: IS_PROD }
}));

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function verificarTwilio(req, res, next) {
  if (TEST_MODE) return next();
  const signature = req.header('X-Twilio-Signature');
  const proto = req.header('x-forwarded-proto') || req.protocol || 'https';
  const url = `${proto}://${req.header('host')}${req.originalUrl}`;
  const valido = twilioLib.validateRequest(
    process.env.TWILIO_AUTH_TOKEN || '',
    signature || '',
    url,
    req.body || {}
  );
  if (!valido) {
    console.warn('Firma Twilio inválida en', req.originalUrl);
    return res.status(403).type('text/xml').send('<Response/>');
  }
  next();
}

const setupMediaStreamWebSocket = TEST_MODE ? null : require('./streaming').setupMediaStreamWebSocket;

app.get('/audio', async (req, res) => {
  try {
    const texto = req.query.texto;
    if (!texto) return res.status(400).send('Sin texto');
    const response = await elevenlabs.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      text: texto,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    if (response.pipe) {
      response.pipe(res);
    } else if (response[Symbol.asyncIterator]) {
      for await (const chunk of response) {
        res.write(chunk);
      }
      res.end();
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    }
  } catch (err) {
    console.error('Error ElevenLabs:', err.message);
    res.status(500).send('Error generando audio');
  }
});

async function enviarWhatsApp(telefono, mensaje) {
  try {
    const to = telefono.startsWith('whatsapp:') ? telefono : `whatsapp:${telefono}`;
    const promesa = twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: to,
      body: mensaje
    }).catch(err => {
      console.error('Error enviando WhatsApp (ignorado):', err.message);
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    await Promise.race([promesa, timeout]);
    console.log('WhatsApp procesado a:', to);
  } catch (err) {
    console.error('Error enviando WhatsApp (ignorado):', err.message);
  }
}

async function enviarEmailRestaurante(usuarioId, datos) {
  try {
    const usuario = await db.query('SELECT * FROM usuarios WHERE id = $1', [usuarioId]);
    if (!usuario.rows.length) return;
    const email = usuario.rows[0].email;
    const restaurante = usuario.rows[0].restaurante;
    await resend.emails.send({
      from: 'ReservasBot <onboarding@resend.dev>',
      to: email,
      subject: `${datos.canal?.includes('CANCELACION') ? '❌ Cancelación' : datos.canal?.includes('MODIFICACION') ? '✏️ Modificación' : '✅ Nueva reserva'} — ${datos.nombre}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; background: #f9f9f9; border-radius: 12px;">
          <h2 style="color: #4F46E5;">${datos.canal?.includes('CANCELACION') ? 'Reserva cancelada' : datos.canal?.includes('MODIFICACION') ? 'Reserva modificada' : 'Nueva reserva'} en ${restaurante}</h2>
          <div style="background: white; border-radius: 8px; padding: 20px; margin-top: 16px;">
            <p style="margin: 8px 0;"><strong>Nombre:</strong> ${datos.nombre}</p>
            <p style="margin: 8px 0;"><strong>Fecha:</strong> ${datos.fecha}</p>
            <p style="margin: 8px 0;"><strong>Hora:</strong> ${datos.hora}</p>
            <p style="margin: 8px 0;"><strong>Personas:</strong> ${datos.personas}</p>
            <p style="margin: 8px 0;"><strong>Canal:</strong> ${datos.canal || 'Bot'}</p>
            ${datos.notas ? `<p style="margin: 8px 0;"><strong>⚠️ Notas:</strong> ${datos.notas}</p>` : ''}
          </div>
          <p style="color: #888; font-size: 12px; margin-top: 16px;">ReservasBot — Panel: https://reservas-bot-production.up.railway.app/panel</p>
        </div>
      `
    });
    console.log('Email enviado a:', email);
  } catch (err) {
    console.error('Error enviando email:', err.message);
  }
}

async function obtenerOCrearCliente(telefono, nombre = null) {
  const cliente = await db.query('SELECT * FROM clientes WHERE telefono = $1', [telefono]);
  if (cliente.rows.length > 0) {
    await db.query('UPDATE clientes SET ultima_visita = NOW() WHERE telefono = $1', [telefono]);
    return cliente.rows[0];
  } else {
    const nuevo = await db.query('INSERT INTO clientes (telefono, nombre) VALUES ($1, $2) RETURNING *', [telefono, nombre]);
    return nuevo.rows[0];
  }
}

async function obtenerContextoCliente(telefono) {
  const cliente = await db.query('SELECT * FROM clientes WHERE telefono = $1', [telefono]);
  const reservas = await db.query('SELECT * FROM reservas WHERE telefono_cliente = $1 ORDER BY creada_en DESC LIMIT 5', [telefono]);
  return {
    cliente: cliente.rows.length > 0 ? cliente.rows[0] : null,
    reservas: reservas.rows
  };
}

async function obtenerUsuarioPorDefecto() {
  const usuario = await db.query('SELECT id FROM usuarios LIMIT 1');
  return usuario.rows.length > 0 ? usuario.rows[0].id : null;
}

async function obtenerUsuarioPorNumero(numero) {
  if (!numero) return await obtenerUsuarioPorDefecto();
  const usuario = await db.query('SELECT id FROM usuarios WHERE numero_twilio = $1', [numero]);
  if (usuario.rows.length > 0) return usuario.rows[0].id;
  return await obtenerUsuarioPorDefecto();
}

// ============================================================
// Disponibilidad de mesas
// ------------------------------------------------------------
// Simula la asignación real de mesas a reservas que solapan en
// el tiempo, usando una estrategia best-fit (la mesa más pequeña
// que acomode al grupo). Esto permite:
//   - Aprovechar al máximo el aforo del restaurante
//   - Reservar mesas grandes para grupos que las necesiten
//   - Hacer overflow a mesas mayores si no hay opción ideal
//   - Bloquear cada mesa durante DURACION_SERVICIO_MIN minutos
//   - Aislar disponibilidad por restaurante (usuario_id)
// ============================================================

const DURACION_SERVICIO_MIN = 90; // tiempo que una mesa queda ocupada

function horaAMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

function minutosAHora(min) {
  const seguro = Math.max(0, Math.min(min, 23 * 60 + 59));
  return `${String(Math.floor(seguro / 60)).padStart(2, '0')}:${String(seguro % 60).padStart(2, '0')}`;
}

/**
 * Comprueba si hay mesa disponible para una reserva.
 *
 * @param {string} fecha           Fecha en formato YYYY-MM-DD
 * @param {string} hora            Hora en formato HH:MM
 * @param {number} personas        Tamaño del grupo
 * @param {number} uid             ID del restaurante
 * @param {number} [excluirId]     ID de reserva a ignorar (al modificar)
 * @returns {Promise<{disponible: boolean, motivo?: string, mesaId?: number}>}
 */
async function hayDisponibilidad(fecha, hora, personas, uid = null, excluirId = null) {
  if (!uid) return { disponible: false, motivo: 'Usuario no identificado.' };
  if (!personas || personas < 1) return { disponible: false, motivo: 'Numero de personas invalido.' };

  // 1. Cargar mesas del restaurante (orden ascendente para best-fit).
  const { rows: mesas } = await db.query(
    'SELECT id, numero, capacidad FROM mesas WHERE usuario_id = $1 ORDER BY capacidad ASC, numero ASC',
    [uid]
  );

  if (mesas.length === 0) {
    return { disponible: false, motivo: 'El restaurante no tiene mesas configuradas.' };
  }

  const capacidadMaxima = mesas.reduce((max, m) => Math.max(max, m.capacidad), 0);
  if (personas > capacidadMaxima) {
    return { disponible: false, motivo: `No tenemos mesas para mas de ${capacidadMaxima} personas.` };
  }

  // 2. Calcular la ventana temporal en la que otra reserva ocuparia la misma mesa.
  //    Dos reservas solapan si la diferencia entre sus horas de inicio < DURACION.
  const minSolicitados = horaAMinutos(hora);
  const ventanaInicio = minutosAHora(minSolicitados - DURACION_SERVICIO_MIN + 1);
  const ventanaFin = minutosAHora(minSolicitados + DURACION_SERVICIO_MIN - 1);

  // 3. Reservas existentes que podrian competir por una mesa en ese momento.
  const params = [uid, fecha, ventanaInicio, ventanaFin];
  let sql = `
    SELECT id, hora, personas
    FROM reservas
    WHERE usuario_id = $1
      AND fecha = $2
      AND hora >= $3
      AND hora <= $4
  `;
  if (excluirId) {
    sql += ' AND id <> $5';
    params.push(excluirId);
  }
  sql += ' ORDER BY hora ASC, id ASC';

  const { rows: reservasSolapadas } = await db.query(sql, params);

  // 4. Simular la asignacion best-fit de mesas a las reservas que ya existen.
  //    A cada reserva confirmada se le da la mesa libre mas pequena que la acomode.
  const mesasOcupadas = new Set();

  for (const r of reservasSolapadas) {
    const minR = horaAMinutos(r.hora);
    if (Math.abs(minR - minSolicitados) >= DURACION_SERVICIO_MIN) continue; // no solapa realmente

    const mesa = mesas.find(m => !mesasOcupadas.has(m.id) && m.capacidad >= r.personas);
    if (mesa) mesasOcupadas.add(mesa.id);
    // Si no encuentra mesa, la reserva existente quedaria sin asignar; la ignoramos
    // porque ya esta confirmada en BD y no afecta a la decision actual.
  }

  // 5. Asignar la mejor mesa libre al grupo solicitado.
  const mesaParaNuevaReserva = mesas.find(m => !mesasOcupadas.has(m.id) && m.capacidad >= personas);

  if (mesaParaNuevaReserva) {
    return { disponible: true, mesaId: mesaParaNuevaReserva.id };
  }

  return {
    disponible: false,
    motivo: `No quedan mesas disponibles para ${personas} personas en ese horario.`
  };
}

function bucketPersonas(p) {
  if (p <= 2) return 2;
  if (p <= 4) return 4;
  if (p <= 6) return 6;
  return Math.ceil(p / 2) * 2;
}

async function obtenerListaEspera(usuarioId, fecha, hora, personas) {
  const lista = await db.query(
    'SELECT COUNT(*) FROM lista_espera WHERE usuario_id = $1 AND fecha = $2 AND hora = $3 AND personas <= $4',
    [usuarioId, fecha, hora, bucketPersonas(personas)]
  );
  return parseInt(lista.rows[0].count);
}

async function avisarListaEspera(usuarioId, fecha, hora, personas) {
  const enEspera = await db.query(
    'SELECT * FROM lista_espera WHERE usuario_id = $1 AND fecha = $2 AND personas <= $3 ORDER BY creada_en ASC LIMIT 1',
    [usuarioId, fecha, bucketPersonas(personas)]
  );
  if (enEspera.rows.length === 0) return;
  const cliente = enEspera.rows[0];
  await enviarWhatsApp(
    cliente.telefono,
    `Hola ${cliente.nombre}, hay un hueco disponible en el restaurante para el ${fecha} a las ${hora} para ${cliente.personas} personas. Responde SI para confirmar tu reserva o NO para cancelar tu espera.`
  );
  await db.query('DELETE FROM lista_espera WHERE id = $1', [cliente.id]);
}

async function extraerDatosReserva(mensajes) {
  const respuesta = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 150,
    messages: [
      ...mensajes,
      { role: 'user', content: `Analiza la conversacion y extrae los datos en formato JSON con estos campos: accion (NUEVA, CANCELAR, MODIFICAR, CONSULTAR, ESPERA o DISPONIBILIDAD), nombre, fecha, hora, personas, notas (alergias, preferencias alimentarias, ocasiones especiales o cualquier nota relevante para el restaurante), nueva_fecha, nueva_hora, nuevas_personas.
        

IMPORTANTE: Si el ultimo mensaje del asistente contiene "ACCION:CONSULTAR" la accion es CONSULTAR. Si contiene "ACCION:NUEVA" la accion es NUEVA. Si contiene "ACCION:CANCELAR" la accion es CANCELAR. Si contiene "ACCION:MODIFICAR" la accion es MODIFICAR. Si contiene "ACCION:ESPERA" la accion es ESPERA. Si contiene "ACCION:DISPONIBILIDAD" la accion es DISPONIBILIDAD.

La fecha debe estar en formato YYYY-MM-DD usando como referencia que hoy es ${new Date().toISOString().split('T')[0]}. La hora en formato HH:MM. Si algun dato no aplica o falta pon null. Responde SOLO con el JSON, sin texto adicional, sin comillas de codigo.` }
    ]
  });
  try {
    const texto = respuesta.choices[0].message.content.replace(/```json|```/g, '').trim();
    console.log('JSON extraido:', texto);
    return JSON.parse(texto);
  } catch (e) {
    console.log('Error parseando JSON:', e.message);
    return null;
  }
}

async function obtenerConfigRestaurante(usuarioId) {
  const config = await db.query('SELECT * FROM configuracion WHERE usuario_id = $1', [usuarioId]);
  return config.rows.length > 0 ? config.rows[0] : null;
}

async function procesarAccion(datos, canal, contexto, telefonoCliente = null, usuarioId = null, config = null) {
  if (!datos) return 'Disculpa, no he podido entender los datos. Puedes repetirmelos?';
  const telefonoParaWhatsapp = telefonoCliente || canal;
  const uid = usuarioId || await obtenerUsuarioPorDefecto();

  if (datos.accion === 'CONSULTAR') {
    const reservas = await db.query(
      'SELECT * FROM reservas WHERE telefono_cliente = $1 AND fecha >= $2 ORDER BY fecha ASC, hora ASC',
      [telefonoParaWhatsapp, new Date().toISOString().split('T')[0]]
    );
    if (reservas.rows.length === 0) return 'No tienes reservas proximas.';
    const lista = reservas.rows.map((r, i) => `${i + 1}) ${r.nombre} - ${r.fecha} a las ${r.hora} para ${r.personas} personas`).join('\n');
    return `Tus reservas proximas son: ${lista}`;
  }

  if (datos.accion === 'CANCELAR') {
    let reserva;
    if (datos.fecha) {
      reserva = await db.query('SELECT * FROM reservas WHERE telefono_cliente = $1 AND fecha = $2 LIMIT 1', [telefonoParaWhatsapp, datos.fecha]);
    } else if (datos.nombre) {
      reserva = await db.query('SELECT * FROM reservas WHERE telefono_cliente = $1 AND LOWER(nombre) = LOWER($2) LIMIT 1', [telefonoParaWhatsapp, datos.nombre]);
    }
    if (!reserva || reserva.rows.length === 0) return 'No encontre esa reserva. Puedes indicarme la fecha o el nombre?';

    const fechaReserva = new Date(`${reserva.rows[0].fecha}T${reserva.rows[0].hora}`);
    const horasRestantes = (fechaReserva - new Date()) / (1000 * 60 * 60);
    if (horasRestantes < 2) return 'Lo siento, no es posible cancelar con menos de 2 horas de antelacion.';

    await db.query('DELETE FROM reservas WHERE id = $1', [reserva.rows[0].id]);
    await avisarListaEspera(uid, reserva.rows[0].fecha, reserva.rows[0].hora, reserva.rows[0].personas);
    await enviarEmailRestaurante(uid, {
      nombre: reserva.rows[0].nombre,
      fecha: reserva.rows[0].fecha,
      hora: reserva.rows[0].hora,
      personas: reserva.rows[0].personas,
      canal: '❌ CANCELACION por cliente'
    });
    return `Reserva de ${reserva.rows[0].nombre} para el ${reserva.rows[0].fecha} a las ${reserva.rows[0].hora} cancelada correctamente.`;
  }

  if (datos.accion === 'MODIFICAR') {
    let reserva;
    if (datos.fecha) {
      reserva = await db.query('SELECT * FROM reservas WHERE telefono_cliente = $1 AND fecha = $2 LIMIT 1', [telefonoParaWhatsapp, datos.fecha]);
    } else if (datos.nombre) {
      reserva = await db.query('SELECT * FROM reservas WHERE telefono_cliente = $1 AND LOWER(nombre) = LOWER($2) LIMIT 1', [telefonoParaWhatsapp, datos.nombre]);
    }
    if (!reserva || reserva.rows.length === 0) return 'No encontre esa reserva. Puedes indicarme la fecha o el nombre?';
    const nuevaFecha = datos.nueva_fecha || reserva.rows[0].fecha;
    const nuevaHora = datos.nueva_hora || reserva.rows[0].hora;
    const nuevasPersonas = datos.nuevas_personas || reserva.rows[0].personas;
    const fechaReserva = new Date(`${nuevaFecha}T${nuevaHora}`);
    if (fechaReserva <= new Date()) return 'La nueva fecha y hora ya han pasado. Puedes indicarme otra?';
    const disponibilidad = await hayDisponibilidad(nuevaFecha, nuevaHora, nuevasPersonas, uid, reserva.rows[0].id);
    if (!disponibilidad.disponible) return `Lo siento, ${disponibilidad.motivo} Te gustaria elegir otra hora o fecha?`;
    await db.query('UPDATE reservas SET fecha = $1, hora = $2, personas = $3 WHERE id = $4', [nuevaFecha, nuevaHora, nuevasPersonas, reserva.rows[0].id]);
    await avisarListaEspera(uid, reserva.rows[0].fecha, reserva.rows[0].hora, reserva.rows[0].personas);
    await enviarEmailRestaurante(uid, {
      nombre: reserva.rows[0].nombre,
      fecha: nuevaFecha,
      hora: nuevaHora,
      personas: nuevasPersonas,
      canal: `✏️ MODIFICACION por cliente (antes: ${reserva.rows[0].fecha} ${reserva.rows[0].hora})`
    });
    return `Reserva modificada correctamente. Nueva fecha: ${nuevaFecha} a las ${nuevaHora} para ${nuevasPersonas} personas.`;
  }
if (datos.accion === 'DISPONIBILIDAD') {
  const fecha = datos.fecha || new Date().toISOString().split('T')[0];
  const personas = datos.personas || 2;
  const horasFiltro = datos.hora;
  
  const horasMediodía = ['13:00','13:30','14:00','14:30','15:00','15:30'];
  const horasNoche = ['20:00','20:30','21:00','21:30','22:00','22:30','23:00'];
  
  let horasAComprobar;
  if (horasFiltro) {
    const horaNum = parseInt(horasFiltro.replace(':', ''));
    horasAComprobar = horaNum >= 2000 ? horasNoche : horasMediodía;
  } else {
    horasAComprobar = [...horasMediodía, ...horasNoche];
  }

  const horasLibres = [];
  for (const hora of horasAComprobar) {
    const disp = await hayDisponibilidad(fecha, hora, personas, uid);
    if (disp.disponible) horasLibres.push(hora);
  }

  if (horasLibres.length === 0) return `Lo siento, no tenemos mesas disponibles para ${personas} personas el ${fecha}.`;
  
  const libresMediaodia = horasLibres.filter(h => parseInt(h.replace(':', '')) < 1600);
  const libresNoche = horasLibres.filter(h => parseInt(h.replace(':', '')) >= 2000);
  
  let respuesta = `Para ${personas} personas el ${fecha} tenemos disponibilidad`;
  if (libresMediaodia.length > 0) respuesta += ` al mediodia: ${libresMediaodia.join(', ')}`;
  if (libresMediaodia.length > 0 && libresNoche.length > 0) respuesta += ` y`;
  if (libresNoche.length > 0) respuesta += ` por la noche: ${libresNoche.join(', ')}`;
  respuesta += `. Quieres reservar alguna de estas horas?`;
  return respuesta;
}
  if (datos.accion === 'ESPERA') {
    if (!datos.nombre || !datos.fecha || !datos.hora || !datos.personas) return 'Necesito tu nombre, fecha, hora y numero de personas para apuntarte a la lista de espera.';
    await db.query(
      'INSERT INTO lista_espera (usuario_id, telefono, nombre, fecha, hora, personas) VALUES ($1, $2, $3, $4, $5, $6)',
      [uid, telefonoParaWhatsapp, datos.nombre, datos.fecha, datos.hora, datos.personas]
    );
    const enEspera = await obtenerListaEspera(uid, datos.fecha, datos.hora, datos.personas);
    return `Perfecto ${datos.nombre}, te he apuntado en la lista de espera para el ${datos.fecha} a las ${datos.hora}. Eres el numero ${enEspera} en la lista. Te avisaremos por WhatsApp si hay una cancelacion.`;
  }

  if (datos.accion === 'NUEVA') {
    if (!datos.nombre || !datos.fecha || !datos.hora || !datos.personas) return 'Necesito tu nombre, fecha, hora y numero de personas para hacer la reserva.';
    const fechaReserva = new Date(`${datos.fecha}T${datos.hora}`);
    if (fechaReserva <= new Date()) return 'Lo siento, esa fecha y hora ya han pasado. Para que otra fecha te gustaria reservar?';

    if (uid) {
      const fechaObj = new Date(datos.fecha);
      const diaSemana = fechaObj.getDay();

      const diaCerrado = await db.query(`
       SELECT * FROM dias_cerrados WHERE usuario_id = $1 AND (
        (tipo = 'fecha' AND fecha = $2) OR
        (tipo = 'semana' AND dia_semana = $3) OR
        (tipo = 'rango' AND fecha <= $2 AND fecha_fin >= $2)
     )`, [uid, datos.fecha, diaSemana]
    );
    if (diaCerrado.rows.length > 0) {
       const motivo = diaCerrado.rows[0].motivo || 'ese dia estamos cerrados';
       return `Lo siento, ${motivo}. No podemos aceptar reservas para esa fecha. Elige otro dia.`;
    }
    }

    if (config?.horario) {
      const horaReserva = parseInt(datos.hora.replace(':', ''));
      const esHorarioValido = (horaReserva >= 1300 && horaReserva <= 1600) || (horaReserva >= 2000 && horaReserva <= 2330);
      if (!esHorarioValido) return `Lo siento, nuestro horario es ${config.horario}. Elige una hora dentro de nuestro horario de apertura.`;
    }

    const disponibilidad = await hayDisponibilidad(datos.fecha, datos.hora, datos.personas, uid);
    if (!disponibilidad.disponible) {
      const enEspera = await obtenerListaEspera(uid, datos.fecha, datos.hora, datos.personas);
      const horaNum = parseInt(datos.hora.replace(':', ''));
      const alternativas = [];
      const horasProbar = [
        String(horaNum - 100).padStart(4, '0'),
        String(horaNum + 100).padStart(4, '0'),
        String(horaNum - 200).padStart(4, '0'),
        String(horaNum + 200).padStart(4, '0')
      ];
      for (const h of horasProbar) {
        const horaFormateada = `${h.slice(0,2)}:${h.slice(2)}`;
        const horaInt = parseInt(h);
        if (horaInt < 1300 || (horaInt > 1600 && horaInt < 2000) || horaInt > 2330) continue;
        const disp = await hayDisponibilidad(datos.fecha, horaFormateada, datos.personas, uid);
        if (disp.disponible) alternativas.push(horaFormateada);
        if (alternativas.length === 2) break;
      }
      const msgEspera = enEspera > 0
        ? `Hay ${enEspera} persona${enEspera > 1 ? 's' : ''} en lista de espera para ese horario.`
        : 'Serias el primero en la lista de espera para ese horario.';

      if (alternativas.length > 0) {
        return `Lo siento, no hay mesas a las ${datos.hora}. Tengo sitio a las ${alternativas.join(' o a las ')}. O si prefieres, puedo apuntarte a la lista de espera — ${msgEspera} Que prefieres, horario alternativo o lista de espera?`;
      }
      return `Lo siento, no hay mesas disponibles el ${datos.fecha}. ${msgEspera} Te apunto en la lista de espera y te aviso si hay una cancelacion?`;
    }

    await db.query(
      'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas, telefono_cliente, usuario_id, canal, notas) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [canal, datos.nombre, datos.fecha, datos.hora, datos.personas, telefonoParaWhatsapp, uid, telefonoCliente && telefonoCliente.includes('whatsapp') ? 'whatsapp' : 'llamada', datos.notas || null]
    );
    await obtenerOCrearCliente(telefonoParaWhatsapp, datos.nombre);
    await enviarEmailRestaurante(uid, { nombre: datos.nombre, fecha: datos.fecha, hora: datos.hora, personas: datos.personas, canal: telefonoCliente?.includes('whatsapp') ? 'whatsapp' : 'llamada' });
    const fechaFormateada = new Date(datos.fecha + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    return `Perfecto ${datos.nombre}, tu reserva esta confirmada para el ${fechaFormateada} a las ${datos.hora} para ${datos.personas} personas. Te esperamos!`;
  }

  return 'No he entendido lo que necesitas. Quieres hacer, consultar, cancelar o modificar una reserva?';
}

const SYSTEM_PROMPT = (hoy, contexto, config = null) => {
  const nombre = config?.restaurante?.trim() || null;
  const direccion = config?.direccion?.trim() || null;
  const horario = config?.horario?.trim() || null;
  const telefono = config?.telefono?.trim() || null;
  const menu = config?.menu?.trim() || null;
  const especialidad = config?.especialidad?.trim() || null;
  const aparcamiento = config?.aparcamiento?.trim() || null;

  // Construye dinamicamente la seccion de info, omitiendo campos vacios.
  const camposInfo = [];
  if (nombre) camposInfo.push(`Nombre: ${nombre}`);
  if (direccion) camposInfo.push(`Direccion: ${direccion}`);
  if (horario) camposInfo.push(`Horario: ${horario}`);
  if (telefono) camposInfo.push(`Telefono: ${telefono}`);
  if (menu) camposInfo.push(`Menu: ${menu}`);
  if (especialidad) camposInfo.push(`Especialidad: ${especialidad}`);
  if (aparcamiento) camposInfo.push(`Aparcamiento: ${aparcamiento}`);

  const seccionInfo = camposInfo.length > 0
    ? camposInfo.join('\n')
    : '(El restaurante aun no ha configurado su informacion publica.)';

  // Lista de campos NO configurados, para que el bot sepa de que no puede hablar.
  const camposVacios = [];
  if (!direccion) camposVacios.push('direccion');
  if (!horario) camposVacios.push('horario');
  if (!telefono) camposVacios.push('telefono');
  if (!menu) camposVacios.push('menu');
  if (!especialidad) camposVacios.push('especialidades');
  if (!aparcamiento) camposVacios.push('aparcamiento');

  const seccionFaltantes = camposVacios.length > 0
    ? `\nNO TIENES INFORMACION sobre: ${camposVacios.join(', ')}. Si el cliente pregunta por algo de esta lista, responde literalmente: "No tengo esa informacion ahora mismo, pero puedo ayudarte con tu reserva."`
    : '';

  const nombreRestaurante = nombre || 'el restaurante';

  let prompt = `Eres Laura, recepcionista profesional de ${nombreRestaurante}. Hoy es ${hoy}.

═══════════════════════════════════
IDENTIDAD Y TONO
═══════════════════════════════════
- Hablas como una recepcionista experimentada: cercana, eficiente y resolutiva.
- Tono natural, nunca robotico. Frases cortas, una idea por frase.
- Maximo 2 frases por respuesta salvo que el cliente pida detalle.
- Nunca te disculpes en exceso. Una disculpa breve si procede y avanza.
- No uses muletillas como "claro que si", "por supuesto", "entendido". Ve al grano.

═══════════════════════════════════
INFORMACION DEL RESTAURANTE (UNICA FUENTE DE VERDAD)
═══════════════════════════════════
${seccionInfo}

REGLA CRITICA: Esta es la UNICA informacion verificada del restaurante. NUNCA inventes datos que no esten aqui (platos, precios, horarios, direcciones, eventos, promociones). Si no esta en esta seccion, no existe para ti.${seccionFaltantes}

═══════════════════════════════════
FORMATO DE FECHAS Y HORAS
═══════════════════════════════════
- Fechas SIEMPRE en formato humano: "el viernes 2 de mayo", NUNCA "2026-05-02".
- Horas SIEMPRE en formato hablado:
  · 13:00 = "la 1 de la tarde"
  · 14:00 = "las 2 de la tarde"
  · 15:00 = "las 3 de la tarde"
  · 20:00 = "las 8 de la noche"
  · 21:00 = "las 9 de la noche"
  · 22:00 = "las 10 de la noche"
  · 23:00 = "las 11 de la noche"
  · 23:30 = "las 11 y media de la noche"
- Si el cliente dice "10 de la noche" entiende 22:00. NUNCA digas que 22:00 esta fuera de horario sin haber convertido primero.
- "Mañana", "pasado mañana", "este viernes" son referencias validas; calcula la fecha exacta a partir de hoy (${hoy}).

═══════════════════════════════════
MEMORIA DE LA CONVERSACION (CRITICO)
═══════════════════════════════════
- Mantienes TODA la informacion que el cliente ha dado durante la llamada.
- Si ya tienes nombre, fecha, hora o personas, NUNCA los vuelvas a pedir.
- Si el cliente cambia de idea (de reserva a lista de espera, p.ej.), reutiliza los datos ya recopilados sin volver a preguntar.
- Si el cliente dice "ya te lo dije" o similar, asume que tiene razon y revisa los datos que ya manejas.

═══════════════════════════════════
ALCANCE DE LA CONVERSACION
═══════════════════════════════════
- Solo respondes sobre temas del restaurante usando la informacion verificada de arriba.
- Si preguntan algo ajeno al restaurante responde exactamente: "Solo puedo ayudarte con temas del restaurante."
- Si preguntan por menu, platos, precios o recomendaciones y SI tienes la informacion, responde con detalle. Si no la tienes, di que no la tienes y ofrece ayudar con la reserva.

═══════════════════════════════════
FLUJO DE NUEVA RESERVA
═══════════════════════════════════
Paso 1. Si falta algun dato (nombre, fecha, hora, personas), preguntalo. Solo pide UN dato por turno.
Paso 2. Cuando tengas los 4 datos, pregunta exactamente: "Tienes alguna alergia, preferencia alimentaria o es alguna ocasion especial?"
Paso 3. Espera la respuesta del cliente. Aunque diga que no, continua al paso 4.
Paso 4. Resume TODOS los datos en una sola frase y pregunta: "Es correcto?"
Paso 5. Espera un "si" claro. Si el cliente duda o dice "espera", vuelve a pedir clarificacion.
Paso 6. Solo cuando confirme con "si" responde EXACTAMENTE: "un momento por favor ACCION:NUEVA"

═══════════════════════════════════
FLUJO DE CANCELACION
═══════════════════════════════════
Paso 1. Identifica que reserva quiere cancelar (por fecha o nombre).
Paso 2. Confirma: "Quieres cancelar la reserva de [nombre] del [fecha] a las [hora]?"
Paso 3. Espera "si" explicito.
Paso 4. Responde EXACTAMENTE: "un momento por favor ACCION:CANCELAR"

═══════════════════════════════════
FLUJO DE MODIFICACION
═══════════════════════════════════
Paso 1. Pregunta QUE quiere cambiar (fecha, hora o personas).
Paso 2. Recoge los nuevos datos.
Paso 3. Confirma: "Cambio tu reserva del [original] al [nuevo]. Es correcto?"
Paso 4. Espera "si" explicito.
Paso 5. Responde EXACTAMENTE: "un momento por favor ACCION:MODIFICAR"

═══════════════════════════════════
FLUJO DE LISTA DE ESPERA
═══════════════════════════════════
- Solo se ofrece cuando una reserva no es posible por falta de mesas.
- Antes de procesarla verifica que tienes nombre, fecha, hora y personas. Reutiliza los datos que el cliente YA dio.
- Confirma: "Te apunto a la lista de espera para [fecha] a las [hora] para [personas] personas. Confirmas?"
- Solo cuando confirme responde EXACTAMENTE: "un momento por favor ACCION:ESPERA"

═══════════════════════════════════
ACCIONES DEL SISTEMA
═══════════════════════════════════
- Nueva reserva: "un momento por favor ACCION:NUEVA"
- Cancelacion: "un momento por favor ACCION:CANCELAR"
- Modificacion: "un momento por favor ACCION:MODIFICAR"
- Consultar reservas del cliente: "un momento por favor ACCION:CONSULTAR"
- Lista de espera: "un momento por favor ACCION:ESPERA"
- Consultar disponibilidad: "un momento por favor ACCION:DISPONIBILIDAD"

═══════════════════════════════════
PROHIBICIONES ABSOLUTAS
═══════════════════════════════════
- No inventes platos, precios, horarios, direcciones, promociones ni cualquier dato que no este en la seccion INFORMACION DEL RESTAURANTE.
- No uses la frase "un momento por favor" salvo cuando vaya seguida de ACCION:XXX.
- No proceses una accion sin confirmacion explicita ("si", "correcto", "confirmo").
- No vuelvas a pedir datos que el cliente ya dio en la misma llamada.
- No digas que una hora esta fuera de horario sin convertirla a 24h primero.
- No asumas que "no" significa cancelar; pregunta si hay duda.
- No prometas confirmacion por SMS, email u otros canales que no controlas.

═══════════════════════════════════
GESTION DE DIFICULTADES
═══════════════════════════════════
- Si no entiendes lo que dice el cliente, pide que repita una vez. Si vuelve a fallar, ofrece transferir a un humano: "Te paso con el restaurante directamente, un momento."
- Si el cliente esta enfadado, mantente calmada y profesional. No te justifiques en exceso. Centra en resolver.
- Si el cliente cambia de tema a algo no permitido, redirige sin dramatismo: "Volvamos a tu reserva. Para que dia la querias?"`;

  if (contexto?.cliente?.nombre) {
    prompt += `

═══════════════════════════════════
CLIENTE CONOCIDO
═══════════════════════════════════
El cliente que llama se llama ${contexto.cliente.nombre}. Saluda con su nombre, pero confirma siempre el nombre para la reserva (puede ser distinto).`;
  }

  if (contexto?.reservas?.length > 0) {
    const reservasTexto = contexto.reservas
      .map(r => `${r.nombre} - ${r.fecha} a las ${r.hora} para ${r.personas} personas`)
      .join('; ');
    prompt += `

Reservas recientes de este telefono: ${reservasTexto}.`;
  }

  return prompt;
};

app.set('view engine', 'ejs');

function requireLogin(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.usuario || req.session.usuario.rol !== 'admin') return res.redirect('/panel');
  next();
}

app.get('/', (req, res) => res.render('landing'));
app.get('/legal', (req, res) => res.render('legal'));

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const usuario = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  if (usuario.rows.length === 0) return res.render('login', { error: 'Email o contrasena incorrectos.' });
  const valido = await bcrypt.compare(password, usuario.rows[0].password);
  if (!valido) return res.render('login', { error: 'Email o contrasena incorrectos.' });
  req.session.usuario = usuario.rows[0];
  if (usuario.rows[0].rol === 'admin') {
    res.redirect('/admin');
  } else {
    res.redirect('/panel');
  }
});

app.get('/registro', (req, res) => res.render('registro', { error: null }));

app.post('/registro', async (req, res) => {
  const { nombre, restaurante, email, password } = req.body;
  const existe = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  if (existe.rows.length > 0) return res.render('registro', { error: 'Ya existe una cuenta con ese email.' });
  const hash = await bcrypt.hash(password, 10);
  await db.query('INSERT INTO usuarios (nombre, email, password, restaurante) VALUES ($1, $2, $3, $4)', [nombre, email, hash, restaurante]);
  res.redirect('/login');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://reservas-bot-production.up.railway.app';
const PUBLIC_WSS_URL = PUBLIC_BASE_URL.replace(/^https?:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

app.post('/llamada', verificarTwilio, async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const telefono = req.body.From || callSid;
    const numeroTwilio = req.body.To || null;
    console.log('Llamada recibida de:', telefono);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(PUBLIC_WSS_URL)}/media-stream">
      <Parameter name="callSid" value="${xmlEscape(callSid)}"/>
      <Parameter name="to" value="${xmlEscape(numeroTwilio || '')}"/>
      <Parameter name="from" value="${xmlEscape(telefono || '')}"/>
    </Stream>
  </Connect>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  } catch (err) {
    console.error('Error en /llamada:', err);
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-ES">Lo sentimos, ha ocurrido un error.</Say></Response>`);
  }
});

app.post('/responder', verificarTwilio, async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const telefono = req.body.From || callSid;
    const numeroTwilio = req.body.To || null;
    const textoCliente = req.body.SpeechResult || '';
    console.log('Cliente dijo:', textoCliente);
    const hoy = new Date().toISOString().split('T')[0];
    const usuarioId = await obtenerUsuarioPorNumero(numeroTwilio);
    const contexto = await obtenerContextoCliente(telefono);
    const config = usuarioId ? await obtenerConfigRestaurante(usuarioId) : null;
    if (!conversaciones[callSid]) {
      conversaciones[callSid] = [{ role: 'system', content: SYSTEM_PROMPT(hoy, contexto, config) }];
    }
    conversaciones[callSid].push({ role: 'user', content: textoCliente });
    const respuestaIA = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: conversaciones[callSid]
    });
    let mensaje = respuestaIA.choices[0].message.content;
    conversaciones[callSid].push({ role: 'assistant', content: mensaje });
    console.log('Mensaje completo:', mensaje);
    if (mensaje.toLowerCase().includes('un momento por favor')) {
      const datos = await extraerDatosReserva(conversaciones[callSid]);
      try {
        mensaje = await procesarAccion(datos, callSid, contexto, telefono, usuarioId, config);
      } catch (err) {
        console.error('Error en procesarAccion:', err.message);
        mensaje = 'Tu reserva ha sido procesada. Te esperamos!';
      }
      console.log('Respuesta final:', mensaje);
      if (mensaje.includes('confirmada') || mensaje.includes('cancelada') || mensaje.includes('modificada') || mensaje.includes('procesada') || mensaje.includes('lista de espera')) {
        const nuevoContexto = await obtenerContextoCliente(telefono);
        conversaciones[callSid] = [
          { role: 'system', content: SYSTEM_PROMPT(hoy, nuevoContexto, config) },
          { role: 'assistant', content: mensaje }
        ];
      }
    }
    const audioUrlResp = `${PUBLIC_BASE_URL}/audio?texto=${encodeURIComponent(mensaje)}`;
    const twiml = ELEVENLABS_ENABLED
      ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="5">
    <Play>${xmlEscape(audioUrlResp)}</Play>
  </Gather>
</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="5">
    <Say language="es-ES">${xmlEscape(mensaje)}</Say>
  </Gather>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  } catch (err) {
    console.error('Error en /responder:', err);
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-ES">Lo sentimos, ha ocurrido un error. Por favor intentelo de nuevo.</Say></Response>`);
  }
});

app.post('/whatsapp', verificarTwilio, async (req, res) => {
  try {
    const from = req.body.From;
    const mensaje = req.body.Body;
    const numeroTwilio = req.body.To || null;
    console.log('WhatsApp de:', from, '→', mensaje);
    const hoy = new Date().toISOString().split('T')[0];
    const usuarioId = await obtenerUsuarioPorNumero(numeroTwilio);
    const contexto = await obtenerContextoCliente(from);
    const config = usuarioId ? await obtenerConfigRestaurante(usuarioId) : null;
    if (!conversacionesWhatsapp[from]) {
      conversacionesWhatsapp[from] = [{ role: 'system', content: SYSTEM_PROMPT(hoy, contexto, config) }];
    }
    conversacionesWhatsapp[from].push({ role: 'user', content: mensaje });
    const respuestaIA = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: conversacionesWhatsapp[from]
    });
    let respuesta = respuestaIA.choices[0].message.content;
    console.log('Bot responde:', respuesta);
    conversacionesWhatsapp[from].push({ role: 'assistant', content: respuesta });
    if (respuesta.toLowerCase().includes('un momento por favor')) {
      const datos = await extraerDatosReserva(conversacionesWhatsapp[from]);
      try {
        respuesta = await procesarAccion(datos, from, contexto, from, usuarioId, config);
      } catch (err) {
        console.error('Error en procesarAccion WhatsApp:', err.message);
        respuesta = 'Tu reserva ha sido procesada. Te esperamos!';
      }
      if (respuesta.includes('confirmada') || respuesta.includes('cancelada') || respuesta.includes('modificada') || respuesta.includes('procesada') || respuesta.includes('lista de espera')) {
        const nuevoContexto = await obtenerContextoCliente(from);
        conversacionesWhatsapp[from] = [
          { role: 'system', content: SYSTEM_PROMPT(hoy, nuevoContexto, config) },
          { role: 'assistant', content: respuesta }
        ];
      }
    }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${xmlEscape(respuesta)}</Message>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  } catch (err) {
    console.error('ERROR en whatsapp:', err);
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Error interno.</Message></Response>`);
  }
});

app.get('/panel', requireLogin, async (req, res) => {
  const fechaFiltro = req.query.fecha || null;
  const error = req.query.error || null;
  const hoy = new Date().toISOString().split('T')[0];
  const usuarioId = req.session.usuario.id;
  const todas = await db.query('SELECT * FROM reservas WHERE usuario_id = $1 ORDER BY creada_en DESC', [usuarioId]);
  const hoyQuery = await db.query('SELECT * FROM reservas WHERE usuario_id = $1 AND fecha = $2 ORDER BY hora ASC', [usuarioId, hoy]);
  let filtradas = [];
  if (fechaFiltro) {
    const filtroQuery = await db.query('SELECT * FROM reservas WHERE usuario_id = $1 AND fecha = $2 ORDER BY hora ASC', [usuarioId, fechaFiltro]);
    filtradas = filtroQuery.rows;
  }
  const espera = await db.query('SELECT * FROM lista_espera WHERE usuario_id = $1 ORDER BY creada_en ASC', [usuarioId]);
  res.render('reservas', {
    reservas: todas.rows,
    reservasHoy: hoyQuery.rows,
    reservasFiltradas: filtradas,
    listaEspera: espera.rows,
    fechaFiltro,
    error,
    usuario: req.session.usuario
  });
});

app.get('/api/reservas', requireLogin, async (req, res) => {
  const resultado = await db.query('SELECT * FROM reservas WHERE usuario_id = $1 ORDER BY creada_en DESC', [req.session.usuario.id]);
  res.json(resultado.rows);
});

app.post('/cancelar/:id', requireLogin, async (req, res) => {
  const reserva = await db.query(
    'SELECT * FROM reservas WHERE id = $1 AND usuario_id = $2',
    [req.params.id, req.session.usuario.id]
  );
  if (reserva.rows.length > 0) {
    const r = reserva.rows[0];
    await db.query('DELETE FROM reservas WHERE id = $1 AND usuario_id = $2', [req.params.id, req.session.usuario.id]);
    await avisarListaEspera(req.session.usuario.id, r.fecha, r.hora, r.personas);
  }
  res.redirect('/panel');
});

app.post('/editar-reserva/:id', requireLogin, async (req, res) => {
  const { nombre, fecha, hora, personas } = req.body;
  const usuarioId = req.session.usuario.id;
  const ahora = new Date();
  const fechaHoraReserva = new Date(`${fecha}T${hora}`);
  if (fechaHoraReserva <= ahora) return res.redirect('/panel?error=fecha');
  const disponibilidad = await hayDisponibilidad(fecha, hora, parseInt(personas), usuarioId, req.params.id);
  if (!disponibilidad.disponible) return res.redirect('/panel?error=cupo');
  await db.query(
    'UPDATE reservas SET nombre=$1, fecha=$2, hora=$3, personas=$4 WHERE id=$5 AND usuario_id=$6',
    [nombre, fecha, hora, parseInt(personas), req.params.id, usuarioId]
  );
  res.redirect('/panel');
});

app.post('/nueva-reserva', requireLogin, async (req, res) => {
  const { nombre, fecha, hora, personas, telefono, prefijo, notas } = req.body;
  const telefonoCompleto = telefono ? `${prefijo || '+34'}${telefono.replace(/\s/g, '')}` : null;
  const ahora = new Date();
  const fechaHoraReserva = new Date(`${fecha}T${hora}`);
  if (fechaHoraReserva <= ahora) return res.redirect('/panel?error=fecha');
  const disponibilidad = await hayDisponibilidad(fecha, hora, parseInt(personas), req.session.usuario.id);
  if (!disponibilidad.disponible) return res.redirect('/panel?error=cupo');
  if (!telefonoCompleto) return res.redirect('/panel?error=telefono');
  await db.query(
    'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas, telefono_cliente, usuario_id, canal, notas) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    ['manual', nombre, fecha, hora, parseInt(personas), telefonoCompleto, req.session.usuario.id, 'manual', notas || null]
  );
  await obtenerOCrearCliente(telefonoCompleto, nombre);
  await enviarEmailRestaurante(req.session.usuario.id, { nombre, fecha, hora, personas, canal: 'manual', notas });
  res.redirect('/panel');
});

app.get('/clientes', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const clientes = await db.query(`
    SELECT c.*, COUNT(r.id) as total_reservas,
      (SELECT r2.canal FROM reservas r2
        WHERE r2.telefono_cliente = c.telefono AND r2.usuario_id = $1
        GROUP BY r2.canal ORDER BY COUNT(*) DESC LIMIT 1) as canal_frecuente
    FROM clientes c
    INNER JOIN reservas r ON r.telefono_cliente = c.telefono
    WHERE r.usuario_id = $1
    GROUP BY c.id
    ORDER BY total_reservas DESC, c.ultima_visita DESC
  `, [usuarioId]);
  res.render('clientes', { clientes: clientes.rows, usuario: req.session.usuario });
});

app.get('/clientes/:id', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const clienteId = req.params.id;
  const cliente = await db.query('SELECT * FROM clientes WHERE id = $1', [clienteId]);
  if (cliente.rows.length === 0) return res.redirect('/clientes');
  const reservas = await db.query(
    'SELECT * FROM reservas WHERE telefono_cliente = $1 AND usuario_id = $2 ORDER BY creada_en DESC',
    [cliente.rows[0].telefono, usuarioId]
  );
  res.render('cliente-detalle', { cliente: cliente.rows[0], reservas: reservas.rows, usuario: req.session.usuario });
});

app.get('/configuracion', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const config = await db.query('SELECT * FROM configuracion WHERE usuario_id = $1', [usuarioId]);
  const mesas = await db.query('SELECT * FROM mesas WHERE usuario_id = $1 ORDER BY numero ASC', [usuarioId]);
  const diasCerrados = await db.query('SELECT * FROM dias_cerrados WHERE usuario_id = $1 ORDER BY fecha ASC', [usuarioId]);
  res.render('configuracion', {
    config: config.rows.length > 0 ? config.rows[0] : {},
    mesas: mesas.rows,
    diasCerrados: diasCerrados.rows,
    usuario: req.session.usuario,
    exito: req.query.exito || null
  });
});

app.post('/configuracion', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const { restaurante, telefono, direccion, horario, aparcamiento, menu, especialidad } = req.body;
  const existe = await db.query('SELECT * FROM configuracion WHERE usuario_id = $1', [usuarioId]);
  if (existe.rows.length > 0) {
    await db.query(
      'UPDATE configuracion SET restaurante=$1, telefono=$2, direccion=$3, horario=$4, aparcamiento=$5, menu=$6, especialidad=$7 WHERE usuario_id=$8',
      [restaurante, telefono, direccion, horario, aparcamiento, menu, especialidad, usuarioId]
    );
  } else {
    await db.query(
      'INSERT INTO configuracion (usuario_id, restaurante, telefono, direccion, horario, aparcamiento, menu, especialidad) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [usuarioId, restaurante, telefono, direccion, horario, aparcamiento, menu, especialidad]
    );
  }
  await db.query('UPDATE usuarios SET restaurante = $1 WHERE id = $2', [restaurante, usuarioId]);
  req.session.usuario.restaurante = restaurante;
  res.redirect('/configuracion?exito=1');
});

app.post('/mesas/añadir', requireLogin, async (req, res) => {
  const { numero, capacidad } = req.body;
  await db.query('INSERT INTO mesas (numero, capacidad, usuario_id) VALUES ($1, $2, $3)', [parseInt(numero), parseInt(capacidad), req.session.usuario.id]);
  res.redirect('/configuracion');
});

app.post('/mesas/eliminar/:id', requireLogin, async (req, res) => {
  await db.query('DELETE FROM mesas WHERE id = $1 AND usuario_id = $2', [req.params.id, req.session.usuario.id]);
  res.redirect('/configuracion');
});

app.post('/dias-cerrados/anadir', requireLogin, async (req, res) => {
  const { fecha, fecha_fin, motivo, tipo, dia_semana } = req.body;
  await db.query(
    'INSERT INTO dias_cerrados (usuario_id, fecha, fecha_fin, motivo, tipo, dia_semana) VALUES ($1, $2, $3, $4, $5, $6)',
    [req.session.usuario.id, fecha || null, fecha_fin || null, motivo || null, tipo || 'fecha', dia_semana || null]
  );
  res.redirect('/configuracion');
});

app.post('/dias-cerrados/eliminar/:id', requireLogin, async (req, res) => {
  await db.query('DELETE FROM dias_cerrados WHERE id = $1 AND usuario_id = $2', [req.params.id, req.session.usuario.id]);
  res.redirect('/configuracion');
});

app.get('/exportar-reservas', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const reservas = await db.query('SELECT * FROM reservas WHERE usuario_id = $1 ORDER BY fecha ASC, hora ASC', [usuarioId]);
  const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    'Nombre,Fecha,Hora,Personas,Canal,Estado,Recibida',
    ...reservas.rows.map(r => [r.nombre, r.fecha, r.hora, r.personas, r.canal || '', r.estado || 'confirmada', new Date(r.creada_en).toLocaleDateString('es-ES')].map(csvCell).join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=reservas.csv');
  res.send(csv);
});

app.get('/admin', requireAdmin, async (req, res) => {
  const restaurantes = await db.query(`
    SELECT u.*, COUNT(r.id) as total_reservas
    FROM usuarios u
    LEFT JOIN reservas r ON r.usuario_id = u.id
    WHERE u.rol != 'admin' OR u.rol IS NULL
    GROUP BY u.id
    ORDER BY u.creado_en DESC
  `);
  const totalReservas = await db.query('SELECT COUNT(*) FROM reservas');
  const totalClientes = await db.query('SELECT COUNT(*) FROM clientes');
  const hoy = new Date().toISOString().split('T')[0];
  const reservasHoy = await db.query('SELECT COUNT(*) FROM reservas WHERE fecha = $1', [hoy]);
  res.render('admin', {
    restaurantes: restaurantes.rows,
    totalReservas: totalReservas.rows[0].count,
    totalClientes: totalClientes.rows[0].count,
    reservasHoy: reservasHoy.rows[0].count,
    usuario: req.session.usuario
  });
});

app.post('/admin/restaurante/:id/eliminar', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM reservas WHERE usuario_id = $1', [req.params.id]);
  await db.query('DELETE FROM lista_espera WHERE usuario_id = $1', [req.params.id]);
  await db.query('DELETE FROM mesas WHERE usuario_id = $1', [req.params.id]);
  await db.query('DELETE FROM configuracion WHERE usuario_id = $1', [req.params.id]);
  await db.query('DELETE FROM dias_cerrados WHERE usuario_id = $1', [req.params.id]);
  await db.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
  res.redirect('/admin');
});

app.get('/test-recordatorios', requireLogin, async (req, res) => {
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaManana = manana.toISOString().split('T')[0];
  const usuarioId = req.session.usuario.id;
  const reservas = await db.query(
    'SELECT r.*, u.email, u.restaurante FROM reservas r JOIN usuarios u ON r.usuario_id = u.id WHERE r.fecha = $1 AND r.usuario_id = $2',
    [fechaManana, usuarioId]
  );
  for (const reserva of reservas.rows) {
    if (reserva.telefono_cliente && reserva.telefono_cliente !== 'manual') {
      await enviarWhatsApp(
        reserva.telefono_cliente,
        `Hola ${reserva.nombre}, te recordamos tu reserva en ${reserva.restaurante} manana ${fechaManana} a las ${reserva.hora} para ${reserva.personas} personas. Si necesitas cancelar o modificar respondenos a este mensaje.`
      );
    }
  }
  res.send(`Recordatorios enviados para ${reservas.rows.length} reservas del ${fechaManana}`);
});

cron.schedule('0 10 * * *', async () => {
  console.log('Ejecutando recordatorios...');
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fechaManana = manana.toISOString().split('T')[0];
    const reservas = await db.query(
      'SELECT r.*, u.email, u.restaurante FROM reservas r JOIN usuarios u ON r.usuario_id = u.id WHERE r.fecha = $1',
      [fechaManana]
    );
    for (const reserva of reservas.rows) {
      if (reserva.telefono_cliente && reserva.telefono_cliente !== 'manual') {
        await enviarWhatsApp(
          reserva.telefono_cliente,
          `Hola ${reserva.nombre}, te recordamos tu reserva en ${reserva.restaurante} manana ${fechaManana} a las ${reserva.hora} para ${reserva.personas} personas.`
        );
      }
      await enviarEmailRestaurante(reserva.usuario_id, {
        nombre: reserva.nombre,
        fecha: reserva.fecha,
        hora: reserva.hora,
        personas: reserva.personas,
        canal: 'Recordatorio automatico'
      });
    }
    console.log('Recordatorios completados.');
  } catch (err) {
    console.error('Error en recordatorios:', err.message);
  }
});
app.post('/borrar-reservas-pasadas', requireLogin, async (req, res) => {
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  await db.query('DELETE FROM reservas WHERE usuario_id = $1 AND fecha < $2', [req.session.usuario.id, hoy]);
  res.redirect('/panel');
});
app.post('/espera/eliminar/:id', requireLogin, async (req, res) => {
  await db.query('DELETE FROM lista_espera WHERE id = $1 AND usuario_id = $2', [req.params.id, req.session.usuario.id]);
  res.redirect('/panel');
});
// ============================================================
// MODO TEST — rutas de simulación (solo activas con TEST_MODE)
// ============================================================
if (TEST_MODE) {
  app.get('/test', async (req, res) => {
    res.render('test', {});
  });

  // Encolar la próxima respuesta del LLM stub (chat completion).
  app.post('/test/llm-next', (req, res) => {
    const { reply, json } = req.body || {};
    if (typeof reply === 'string') stubs.queueChatReply(reply);
    if (json !== undefined) stubs.queueExtractJson(json);
    res.json({ ok: true, queueChatSize: stubs.peekChatQueue(), queueJsonSize: stubs.peekJsonQueue() });
  });

  // Reset del estado: vacía conversaciones + re-seed BD.
  app.post('/test/reset', async (req, res) => {
    for (const k of Object.keys(conversaciones)) delete conversaciones[k];
    for (const k of Object.keys(conversacionesWhatsapp)) delete conversacionesWhatsapp[k];
    stubs.clearQueues();
    await stubs.resetDb(db);
    res.json({ ok: true });
  });

  // Snapshot del estado de la BD para el panel.
  app.get('/test/estado', async (req, res) => {
    const usuarioId = (await db.query('SELECT id FROM usuarios WHERE email = $1', ['test@test.com'])).rows[0]?.id;
    const reservas = await db.query('SELECT * FROM reservas WHERE usuario_id = $1 ORDER BY fecha, hora', [usuarioId]);
    const mesas = await db.query('SELECT * FROM mesas WHERE usuario_id = $1 ORDER BY numero', [usuarioId]);
    const espera = await db.query('SELECT * FROM lista_espera WHERE usuario_id = $1 ORDER BY creada_en', [usuarioId]);
    const clientes = await db.query('SELECT * FROM clientes ORDER BY ultima_visita DESC LIMIT 20');
    res.json({
      usuarioId,
      reservas: reservas.rows,
      mesas: mesas.rows,
      lista_espera: espera.rows,
      clientes: clientes.rows,
      llm_queues: { chat: stubs.peekChatQueue(), json: stubs.peekJsonQueue() }
    });
  });

  // Disparar procesarAccion sin pasar por el LLM (útil para testear lógica de negocio).
  app.post('/test/accion-directa', async (req, res) => {
    const { datos, telefono = '+34600000000' } = req.body || {};
    const usuarioId = (await db.query('SELECT id FROM usuarios WHERE email = $1', ['test@test.com'])).rows[0]?.id;
    const config = await obtenerConfigRestaurante(usuarioId);
    const contexto = await obtenerContextoCliente(telefono);
    try {
      const respuesta = await procesarAccion(datos, telefono, contexto, telefono, usuarioId, config);
      res.json({ ok: true, respuesta });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Login automático opcional para acceder al panel /panel sin formulario.
  app.get('/test/login', async (req, res) => {
    const u = await db.query('SELECT * FROM usuarios WHERE email = $1', ['test@test.com']);
    if (u.rows.length) {
      req.session.usuario = u.rows[0];
      return res.redirect('/panel');
    }
    res.status(404).send('Usuario test no encontrado');
  });
}

const PORT = process.env.PORT || 3000;
const server = require('http').createServer(app);

if (!TEST_MODE) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server, path: '/media-stream' });
  setupMediaStreamWebSocket(wss, openai, db, procesarAccion, obtenerContextoCliente, obtenerUsuarioPorNumero, obtenerConfigRestaurante, SYSTEM_PROMPT);
}

async function bootstrap() {
  if (TEST_MODE && stubs?.initDb) {
    await stubs.initDb(db);
    console.log('✅ Base de datos en memoria inicializada con datos de prueba.');
  }
  server.listen(PORT, () => {
    console.log('Servidor escuchando en puerto', PORT);
    if (TEST_MODE) {
      console.log(`\n🧪 Panel de pruebas: http://localhost:${PORT}/test`);
      console.log(`   Login: test@test.com / test\n`);
    }
  });
}
bootstrap().catch(err => {
  console.error('Error al arrancar:', err);
  process.exit(1);
});
