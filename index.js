require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));

const bcrypt = require('bcrypt');
const session = require('express-session');
const cron = require('node-cron');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { ElevenLabsClient } = require('elevenlabs');
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const ELEVENLABS_ENABLED = process.env.ELEVENLABS_ENABLED === 'true';
const ELEVENLABS_VOICE_ID = 'uQw4jpKzMLrZuo0RLPS9';

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversaciones = {};
const conversacionesWhatsapp = {};

app.use(session({
  secret: process.env.SESSION_SECRET || 'reservasbot_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

app.get('/audio', async (req, res) => {
  try {
    const texto = req.query.texto;
    if (!texto) return res.status(400).send('Sin texto');
    const audioStream = await elevenlabs.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      text: texto,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    audioStream.pipe(res);
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
      subject: `Nueva reserva — ${datos.nombre}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; background: #f9f9f9; border-radius: 12px;">
          <h2 style="color: #4F46E5;">Nueva reserva en ${restaurante}</h2>
          <div style="background: white; border-radius: 8px; padding: 20px; margin-top: 16px;">
            <p style="margin: 8px 0;"><strong>Nombre:</strong> ${datos.nombre}</p>
            <p style="margin: 8px 0;"><strong>Fecha:</strong> ${datos.fecha}</p>
            <p style="margin: 8px 0;"><strong>Hora:</strong> ${datos.hora}</p>
            <p style="margin: 8px 0;"><strong>Personas:</strong> ${datos.personas}</p>
            <p style="margin: 8px 0;"><strong>Canal:</strong> ${datos.canal || 'Bot'}</p>
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

async function hayDisponibilidad(fecha, hora, personas) {
  if (personas > 4) return { disponible: false, motivo: 'No tenemos mesas para mas de 4 personas.' };
  const capacidadNecesaria = personas <= 2 ? 2 : 4;
  const mesasAdecuadas = await db.query('SELECT id FROM mesas WHERE capacidad = $1', [capacidadNecesaria]);
  const [horaH, horaM] = hora.split(':').map(Number);
  const horaInicio = `${String(horaH - 1).padStart(2, '0')}:${String(horaM).padStart(2, '0')}`;
  const horaFin = `${String(horaH + 1).padStart(2, '0')}:${String(horaM).padStart(2, '0')}`;
  const reservasOcupadas = await db.query(
    `SELECT COUNT(*) FROM reservas WHERE fecha = $1 AND hora >= $2 AND hora <= $3 AND personas > $4`,
    [fecha, horaInicio, horaFin, capacidadNecesaria === 2 ? 0 : 2]
  );
  const totalMesas = mesasAdecuadas.rows.length;
  const ocupadas = parseInt(reservasOcupadas.rows[0].count);
  if (ocupadas >= totalMesas) return { disponible: false, motivo: `No quedan mesas disponibles para ${personas} personas en ese horario.` };
  return { disponible: true };
}

async function extraerDatosReserva(mensajes) {
  const respuesta = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      ...mensajes,
      { role: 'user', content: `Extrae los datos en formato JSON con estos campos: accion (NUEVA, CANCELAR, MODIFICAR o CONSULTAR), nombre, fecha, hora, personas, nueva_fecha, nueva_hora, nuevas_personas. La fecha debe estar en formato YYYY-MM-DD usando como referencia que hoy es ${new Date().toISOString().split('T')[0]}. La hora en formato HH:MM. Si algun dato no aplica o falta pon null. Responde SOLO con el JSON, sin texto adicional, sin comillas de codigo.` }
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

async function procesarAccion(datos, canal, contexto, telefonoCliente = null, usuarioId = null) {
  if (!datos) return 'Disculpa, no he podido entender los datos. Puedes repetirmelos?';
  const telefonoParaWhatsapp = telefonoCliente || canal;

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
    await db.query('DELETE FROM reservas WHERE id = $1', [reserva.rows[0].id]);
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
    const disponibilidad = await hayDisponibilidad(nuevaFecha, nuevaHora, nuevasPersonas);
    if (!disponibilidad.disponible) return `Lo siento, ${disponibilidad.motivo} Te gustaria elegir otra hora o fecha?`;
    await db.query('UPDATE reservas SET fecha = $1, hora = $2, personas = $3 WHERE id = $4', [nuevaFecha, nuevaHora, nuevasPersonas, reserva.rows[0].id]);
    return `Reserva modificada correctamente. Nueva fecha: ${nuevaFecha} a las ${nuevaHora} para ${nuevasPersonas} personas.`;
  }

  if (datos.accion === 'NUEVA') {
    if (!datos.nombre || !datos.fecha || !datos.hora || !datos.personas) return 'Necesito tu nombre, fecha, hora y numero de personas para hacer la reserva.';
    const fechaReserva = new Date(`${datos.fecha}T${datos.hora}`);
    if (fechaReserva <= new Date()) return 'Lo siento, esa fecha y hora ya han pasado. Para que otra fecha te gustaria reservar?';
    const disponibilidad = await hayDisponibilidad(datos.fecha, datos.hora, datos.personas);
    if (!disponibilidad.disponible) return `Lo siento, ${disponibilidad.motivo} Te gustaria reservar para otra hora o fecha?`;
    const uid = usuarioId || await obtenerUsuarioPorDefecto();
    const canalTipo = telefonoCliente && telefonoCliente.includes('whatsapp') ? 'whatsapp' : 'llamada';
    await db.query(
      'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas, telefono_cliente, usuario_id, canal) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [canal, datos.nombre, datos.fecha, datos.hora, datos.personas, telefonoParaWhatsapp, uid, canalTipo]
    );
    await obtenerOCrearCliente(telefonoParaWhatsapp, datos.nombre);
    await enviarEmailRestaurante(uid, { nombre: datos.nombre, fecha: datos.fecha, hora: datos.hora, personas: datos.personas, canal: canalTipo });
    return `Perfecto ${datos.nombre}, tu reserva esta confirmada para el ${datos.fecha} a las ${datos.hora} para ${datos.personas} personas. Te esperamos!`;
  }

  return 'No he entendido lo que necesitas. Quieres hacer, consultar, cancelar o modificar una reserva?';
}

const SYSTEM_PROMPT = (hoy, contexto, config = null) => {
  const nombre = config?.restaurante || 'Restaurante El Ejemplo';
  const direccion = config?.direccion || 'Calle Mayor 1, Madrid';
  const horario = config?.horario || 'Lunes a domingo de 13:00 a 16:00 y de 20:00 a 23:30';
  const telefono = config?.telefono || '910 000 000';
  const menu = config?.menu || 'Entrantes desde 8 euros, carnes desde 18 euros, pescados desde 16 euros, postres desde 5 euros.';
  const especialidad = config?.especialidad || 'Cocido madrileno los jueves';
  const aparcamiento = config?.aparcamiento || 'Parking publico a 200 metros';

  let prompt = `Eres Mario, asistente de reservas de ${nombre}. Hoy es ${hoy}.

REGLAS ESTRICTAS:
- Responde SIEMPRE en menos de 2 frases cortas
- NUNCA uses listas ni puntos
- NUNCA repitas informacion que el cliente ya dio
- Solo hablas de este restaurante. Si preguntan otra cosa: "Solo puedo ayudarte con el restaurante."

INFO DEL RESTAURANTE:
Direccion: ${direccion} | Horario: ${horario} | Tel: ${telefono} | Menu: ${menu} | Especialidad: ${especialidad} | Parking: ${aparcamiento}

GESTION DE RESERVAS:
Cuando tengas nombre+fecha+hora+personas, resume los datos al cliente y pregunta "Es correcto?". Solo cuando el cliente confirme di EXACTAMENTE una de estas frases sin anadir nada mas:
"un momento por favor ACCION:NUEVA"
"un momento por favor ACCION:CANCELAR"
"un momento por favor ACCION:MODIFICAR"
"un momento por favor ACCION:CONSULTAR"`;

  if (contexto?.cliente?.nombre) {
    prompt += ` El cliente se llama ${contexto.cliente.nombre}, saludale por su nombre.`;
  }
  if (contexto?.reservas?.length > 0) {
    const reservasTexto = contexto.reservas.map(r => `${r.nombre} - ${r.fecha} a las ${r.hora} para ${r.personas} personas`).join(', ');
    prompt += ` Sus reservas recientes: ${reservasTexto}.`;
  }

  return prompt;
};

app.set('view engine', 'ejs');

function requireLogin(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const usuario = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  if (usuario.rows.length === 0) return res.render('login', { error: 'Email o contrasena incorrectos.' });
  const valido = await bcrypt.compare(password, usuario.rows[0].password);
  if (!valido) return res.render('login', { error: 'Email o contrasena incorrectos.' });
  req.session.usuario = usuario.rows[0];
  res.redirect('/panel');
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

app.post('/llamada', async (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const telefono = req.body.From || callSid;
    const numeroTwilio = req.body.To || null;
    const hoy = new Date().toISOString().split('T')[0];
    console.log('Llamada recibida de:', telefono);
    const usuarioId = await obtenerUsuarioPorNumero(numeroTwilio);
    const contexto = await obtenerContextoCliente(telefono);
    const config = usuarioId ? await obtenerConfigRestaurante(usuarioId) : null;
    conversaciones[callSid] = [{ role: 'system', content: SYSTEM_PROMPT(hoy, contexto, config) }];

    const saludo = contexto?.cliente?.nombre
      ? `Hola ${contexto.cliente.nombre}, soy Laura, la asistente del restaurante. En que puedo ayudarte?`
      : 'Hola, soy Laura, la asistente del restaurante. En que puedo ayudarte?';

    const audioUrl = `https://reservas-bot-production.up.railway.app/audio?texto=${encodeURIComponent(saludo)}`;
    const twiml = ELEVENLABS_ENABLED
      ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="8">
    <Play>${audioUrl}</Play>
  </Gather>
</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="8">
    <Say language="es-ES">${saludo}</Say>
  </Gather>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  } catch (err) {
    console.error('Error en /llamada:', err);
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="es-ES">Lo sentimos, ha ocurrido un error. Por favor intentelo de nuevo.</Say></Response>`);
  }
});

app.post('/responder', async (req, res) => {
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
      messages: conversaciones[callSid]
    });
    let mensaje = respuestaIA.choices[0].message.content;
    conversaciones[callSid].push({ role: 'assistant', content: mensaje });
    console.log('Mensaje completo:', mensaje);

    if (mensaje.toLowerCase().includes('un momento por favor')) {
      const datos = await extraerDatosReserva(conversaciones[callSid]);
      try {
        mensaje = await procesarAccion(datos, callSid, contexto, telefono, usuarioId);
      } catch (err) {
        console.error('Error en procesarAccion:', err.message);
        mensaje = 'Tu reserva ha sido procesada. Te esperamos!';
      }
      console.log('Respuesta final:', mensaje);
      if (mensaje.includes('confirmada') || mensaje.includes('cancelada') || mensaje.includes('modificada') || mensaje.includes('procesada')) {
        const nuevoContexto = await obtenerContextoCliente(telefono);
        conversaciones[callSid] = [
          { role: 'system', content: SYSTEM_PROMPT(hoy, nuevoContexto, config) },
          { role: 'assistant', content: mensaje }
        ];
      }
    }

    const audioUrlResp = `https://reservas-bot-production.up.railway.app/audio?texto=${encodeURIComponent(mensaje)}`;
    const twiml = ELEVENLABS_ENABLED
      ? `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="8">
    <Play>${audioUrlResp}</Play>
  </Gather>
</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="8">
    <Say language="es-ES">${mensaje}</Say>
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

app.post('/whatsapp', async (req, res) => {
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
      messages: conversacionesWhatsapp[from]
    });
    let respuesta = respuestaIA.choices[0].message.content;
    console.log('Bot responde:', respuesta);
    conversacionesWhatsapp[from].push({ role: 'assistant', content: respuesta });
    if (respuesta.toLowerCase().includes('un momento por favor')) {
      const datos = await extraerDatosReserva(conversacionesWhatsapp[from]);
      try {
        respuesta = await procesarAccion(datos, from, contexto, from, usuarioId);
      } catch (err) {
        console.error('Error en procesarAccion WhatsApp:', err.message);
        respuesta = 'Tu reserva ha sido procesada. Te esperamos!';
      }
      if (respuesta.includes('confirmada') || respuesta.includes('cancelada') || respuesta.includes('modificada') || respuesta.includes('procesada')) {
        const nuevoContexto = await obtenerContextoCliente(from);
        conversacionesWhatsapp[from] = [
          { role: 'system', content: SYSTEM_PROMPT(hoy, nuevoContexto, config) },
          { role: 'assistant', content: respuesta }
        ];
      }
    }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${respuesta}</Message>
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
  res.render('reservas', {
    reservas: todas.rows,
    reservasHoy: hoyQuery.rows,
    reservasFiltradas: filtradas,
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
  await db.query('DELETE FROM reservas WHERE id = $1 AND usuario_id = $2', [req.params.id, req.session.usuario.id]);
  res.redirect('/panel');
});

app.post('/nueva-reserva', requireLogin, async (req, res) => {
  const { nombre, fecha, hora, personas, telefono, prefijo } = req.body;
  const telefonoCompleto = telefono ? `${prefijo || '+34'}${telefono.replace(/\s/g, '')}` : null;
  const ahora = new Date();
  const fechaHoraReserva = new Date(`${fecha}T${hora}`);
  if (fechaHoraReserva <= ahora) return res.redirect('/panel?error=fecha');
  const disponibilidad = await hayDisponibilidad(fecha, hora, parseInt(personas));
  if (!disponibilidad.disponible) return res.redirect('/panel?error=cupo');
  if (!telefonoCompleto) return res.redirect('/panel?error=telefono');
  await db.query(
    'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas, telefono_cliente, usuario_id, canal) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    ['manual', nombre, fecha, hora, parseInt(personas), telefonoCompleto, req.session.usuario.id, 'manual']
  );
  await obtenerOCrearCliente(telefonoCompleto, nombre);
  await enviarEmailRestaurante(req.session.usuario.id, { nombre, fecha, hora, personas, canal: 'manual' });
  res.redirect('/panel');
});

app.get('/clientes', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const clientes = await db.query(`
    SELECT c.*, COUNT(r.id) as total_reservas,
    MODE() WITHIN GROUP (ORDER BY r.canal) as canal_frecuente
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
  const mesas = await db.query('SELECT * FROM mesas ORDER BY numero ASC');
  res.render('configuracion', {
    config: config.rows.length > 0 ? config.rows[0] : {},
    mesas: mesas.rows,
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
  await db.query('INSERT INTO mesas (numero, capacidad) VALUES ($1, $2)', [parseInt(numero), parseInt(capacidad)]);
  res.redirect('/configuracion');
});

app.post('/mesas/eliminar/:id', requireLogin, async (req, res) => {
  await db.query('DELETE FROM mesas WHERE id = $1', [req.params.id]);
  res.redirect('/configuracion');
});

app.get('/exportar-reservas', requireLogin, async (req, res) => {
  const usuarioId = req.session.usuario.id;
  const reservas = await db.query('SELECT * FROM reservas WHERE usuario_id = $1 ORDER BY fecha ASC, hora ASC', [usuarioId]);
  const csv = [
    'Nombre,Fecha,Hora,Personas,Canal,Estado,Recibida',
    ...reservas.rows.map(r => `${r.nombre},${r.fecha},${r.hora},${r.personas},${r.canal || ''},${r.estado || 'confirmada'},${new Date(r.creada_en).toLocaleDateString('es-ES')}`)
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=reservas.csv');
  res.send(csv);
});

app.get('/test-recordatorios', requireLogin, async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor escuchando en puerto', PORT);
});
```

Guarda, commit y push. Luego añade en Railway → Variables:
```
ELEVENLABS_ENABLED=true