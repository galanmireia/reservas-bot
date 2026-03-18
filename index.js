require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { Pool } = require('pg');
const db = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversaciones = {};
const conversacionesWhatsapp = {};

async function enviarWhatsApp(telefono, mensaje) {
  try {
    const to = telefono.startsWith('whatsapp:') ? telefono : `whatsapp:${telefono}`;
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: to,
      body: mensaje
    });
    console.log('WhatsApp enviado a:', to);
  } catch (err) {
    console.error('Error enviando WhatsApp:', err.message);
  }
}

async function obtenerOCrearCliente(telefono, nombre = null) {
  const cliente = await db.query('SELECT * FROM clientes WHERE telefono = $1', [telefono]);
  if (cliente.rows.length > 0) {
    await db.query('UPDATE clientes SET ultima_visita = NOW() WHERE telefono = $1', [telefono]);
    return cliente.rows[0];
  } else {
    const nuevo = await db.query(
      'INSERT INTO clientes (telefono, nombre) VALUES ($1, $2) RETURNING *',
      [telefono, nombre]
    );
    return nuevo.rows[0];
  }
}

async function obtenerContextoCliente(telefono) {
  const cliente = await db.query('SELECT * FROM clientes WHERE telefono = $1', [telefono]);
  const reservas = await db.query(
    'SELECT * FROM reservas WHERE telefono_cliente = $1 ORDER BY creada_en DESC LIMIT 5',
    [telefono]
  );
  return {
    cliente: cliente.rows.length > 0 ? cliente.rows[0] : null,
    reservas: reservas.rows
  };
}

async function hayDisponibilidad(fecha, hora, personas) {
  if (personas > 4) return { disponible: false, motivo: 'No tenemos mesas para mas de 4 personas.' };

  const capacidadNecesaria = personas <= 2 ? 2 : 4;
  const mesasAdecuadas = await db.query('SELECT id FROM mesas WHERE capacidad = $1', [capacidadNecesaria]);

  const [horaH, horaM] = hora.split(':').map(Number);
  const horaInicio = `${String(horaH - 1).padStart(2, '0')}:${String(horaM).padStart(2, '0')}`;
  const horaFin = `${String(horaH + 1).padStart(2, '0')}:${String(horaM).padStart(2, '0')}`;

  const reservasOcupadas = await db.query(
    `SELECT COUNT(*) FROM reservas 
     WHERE fecha = $1 AND hora >= $2 AND hora <= $3 AND personas > $4`,
    [fecha, horaInicio, horaFin, capacidadNecesaria === 2 ? 0 : 2]
  );

  const totalMesas = mesasAdecuadas.rows.length;
  const ocupadas = parseInt(reservasOcupadas.rows[0].count);

  if (ocupadas >= totalMesas) {
    return { disponible: false, motivo: `No quedan mesas disponibles para ${personas} personas en ese horario.` };
  }

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

async function procesarAccion(datos, canal, contexto, telefonoCliente = null) {
  if (!datos) return 'Disculpa, no he podido entender los datos. Puedes repetirmelos?';

  const telefonoParaWhatsapp = telefonoCliente || canal;

  if (datos.accion === 'CONSULTAR') {
    const reservas = await db.query(
      'SELECT * FROM reservas WHERE telefono_cliente = $1 AND fecha >= $2 ORDER BY fecha ASC, hora ASC',
      [telefonoParaWhatsapp, new Date().toISOString().split('T')[0]]
    );
    if (reservas.rows.length === 0) {
      return 'No tienes reservas proximas.';
    }
    const lista = reservas.rows.map((r, i) => `${i + 1}) ${r.nombre} - ${r.fecha} a las ${r.hora} para ${r.personas} personas`).join('\n');
    return `Tus reservas proximas son:\n${lista}`;
  }

  if (datos.accion === 'CANCELAR') {
    let reserva;
    if (datos.fecha) {
      reserva = await db.query(
        'SELECT * FROM reservas WHERE telefono_cliente = $1 AND fecha = $2 LIMIT 1',
        [telefonoParaWhatsapp, datos.fecha]
      );
    } else if (datos.nombre) {
      reserva = await db.query(
        'SELECT * FROM reservas WHERE telefono_cliente = $1 AND LOWER(nombre) = LOWER($2) LIMIT 1',
        [telefonoParaWhatsapp, datos.nombre]
      );
    }

    if (!reserva || reserva.rows.length === 0) {
      return 'No encontre esa reserva. Puedes indicarme la fecha o el nombre con el que esta hecha?';
    }
    await db.query('DELETE FROM reservas WHERE id = $1', [reserva.rows[0].id]);

    await enviarWhatsApp(telefonoParaWhatsapp, `Tu reserva de ${reserva.rows[0].nombre} para el ${reserva.rows[0].fecha} a las ${reserva.rows[0].hora} ha sido cancelada correctamente.`);

    return `Reserva de ${reserva.rows[0].nombre} para el ${reserva.rows[0].fecha} a las ${reserva.rows[0].hora} cancelada correctamente.`;
  }

  if (datos.accion === 'MODIFICAR') {
    let reserva;
    if (datos.fecha) {
      reserva = await db.query(
        'SELECT * FROM reservas WHERE telefono_cliente = $1 AND fecha = $2 LIMIT 1',
        [telefonoParaWhatsapp, datos.fecha]
      );
    } else if (datos.nombre) {
      reserva = await db.query(
        'SELECT * FROM reservas WHERE telefono_cliente = $1 AND LOWER(nombre) = LOWER($2) LIMIT 1',
        [telefonoParaWhatsapp, datos.nombre]
      );
    }

    if (!reserva || reserva.rows.length === 0) {
      return 'No encontre esa reserva. Puedes indicarme la fecha o el nombre con el que esta hecha?';
    }

    const nuevaFecha = datos.nueva_fecha || reserva.rows[0].fecha;
    const nuevaHora = datos.nueva_hora || reserva.rows[0].hora;
    const nuevasPersonas = datos.nuevas_personas || reserva.rows[0].personas;

    const fechaReserva = new Date(`${nuevaFecha}T${nuevaHora}`);
    if (fechaReserva <= new Date()) {
      return 'La nueva fecha y hora ya han pasado. Puedes indicarme otra fecha u hora?';
    }

    const disponibilidad = await hayDisponibilidad(nuevaFecha, nuevaHora, nuevasPersonas);
    if (!disponibilidad.disponible) {
      return `Lo siento, ${disponibilidad.motivo} Te gustaria elegir otra hora o fecha?`;
    }

    await db.query(
      'UPDATE reservas SET fecha = $1, hora = $2, personas = $3 WHERE id = $4',
      [nuevaFecha, nuevaHora, nuevasPersonas, reserva.rows[0].id]
    );

    await enviarWhatsApp(telefonoParaWhatsapp, `Tu reserva ha sido modificada correctamente:\n- Fecha: ${nuevaFecha}\n- Hora: ${nuevaHora}\n- Personas: ${nuevasPersonas}`);

    return `Reserva modificada correctamente. Nueva fecha: ${nuevaFecha} a las ${nuevaHora} para ${nuevasPersonas} personas.`;
  }

  if (datos.accion === 'NUEVA') {
    if (!datos.nombre || !datos.fecha || !datos.hora || !datos.personas) {
      return 'Necesito tu nombre, fecha, hora y numero de personas para hacer la reserva.';
    }

    const fechaReserva = new Date(`${datos.fecha}T${datos.hora}`);
    if (fechaReserva <= new Date()) {
      return 'Lo siento, esa fecha y hora ya han pasado. Para que otra fecha o hora te gustaria reservar?';
    }

    const disponibilidad = await hayDisponibilidad(datos.fecha, datos.hora, datos.personas);
    if (!disponibilidad.disponible) {
      return `Lo siento, ${disponibilidad.motivo} Te gustaria reservar para otra hora o fecha?`;
    }

    await db.query(
      'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas, telefono_cliente) VALUES ($1, $2, $3, $4, $5, $6)',
      [canal, datos.nombre, datos.fecha, datos.hora, datos.personas, telefonoParaWhatsapp]
    );

    await obtenerOCrearCliente(telefonoParaWhatsapp, datos.nombre);

    await enviarWhatsApp(telefonoParaWhatsapp, `Hola ${datos.nombre}, tu reserva en Restaurante El Ejemplo esta confirmada:\n- Fecha: ${datos.fecha}\n- Hora: ${datos.hora}\n- Personas: ${datos.personas}\nSi necesitas cancelar o modificar contacta con nosotros. Te esperamos!`);

    return `Perfecto ${datos.nombre}, tu reserva esta confirmada para el ${datos.fecha} a las ${datos.hora} para ${datos.personas} personas. Te esperamos!`;
  }

  return 'No he entendido lo que necesitas. Quieres hacer, consultar, cancelar o modificar una reserva?';
}

const SYSTEM_PROMPT = (hoy, contexto) => {
  let prompt = `Eres un asistente virtual del restaurante llamado Mario. La fecha de hoy es ${hoy}. Solo puedes hablar sobre temas relacionados con el restaurante. Si el cliente pregunta sobre cualquier otro tema responde: "Lo siento, solo puedo ayudarte con informacion sobre el restaurante."

Informacion del restaurante:
- Nombre: Restaurante El Ejemplo
- Direccion: Calle Mayor 1, Madrid
- Horario: Lunes a domingo de 13:00 a 16:00 y de 20:00 a 23:30
- Telefono: 910 000 000
- Menu: Entrantes desde 8 euros, carnes desde 18 euros, pescados desde 16 euros, postres desde 5 euros. Especialidad: cocido madrileno los jueves.
- Aparcamiento: No disponible, pero hay parking publico a 200 metros.

Puedes ayudar al cliente a: 1) HACER una reserva nueva. 2) CANCELAR una reserva existente. 3) MODIFICAR una reserva existente. 4) CONSULTAR sus reservas. 5) RESPONDER preguntas sobre el restaurante, menu, horarios y ubicacion.

Se amable y breve. Cuando el cliente quiera gestionar una reserva y tengas todos los datos necesarios di EXACTAMENTE: "un momento por favor" e indica la accion con ACCION:NUEVA, ACCION:CANCELAR, ACCION:MODIFICAR o ACCION:CONSULTAR.`;

  if (contexto && contexto.cliente && contexto.cliente.nombre) {
    prompt += ` El cliente que contacta se llama ${contexto.cliente.nombre}, saludale por su nombre desde el principio.`;
  }

  if (contexto && contexto.reservas && contexto.reservas.length > 0) {
    const reservasTexto = contexto.reservas.map(r => `${r.nombre} - ${r.fecha} a las ${r.hora} para ${r.personas} personas`).join(', ');
    prompt += ` Sus reservas recientes son: ${reservasTexto}. Usalas como contexto si el cliente quiere cancelar o modificar sin dar mas detalles.`;
  }

  return prompt;
};

app.set('view engine', 'ejs');
const bcrypt = require('bcrypt');
const session = require('express-session');

app.use(session({
  secret: 'reservasbot_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireLogin(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const usuario = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  if (usuario.rows.length === 0) {
    return res.render('login', { error: 'Email o contraseña incorrectos.' });
  }
  const valido = await bcrypt.compare(password, usuario.rows[0].password);
  if (!valido) {
    return res.render('login', { error: 'Email o contraseña incorrectos.' });
  }
  req.session.usuario = usuario.rows[0];
  res.redirect('/panel');
});

app.get('/registro', (req, res) => {
  res.render('registro', { error: null });
});

app.post('/registro', async (req, res) => {
  const { nombre, restaurante, email, password } = req.body;
  const existe = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  if (existe.rows.length > 0) {
    return res.render('registro', { error: 'Ya existe una cuenta con ese email.' });
  }
  const hash = await bcrypt.hash(password, 10);
  await db.query(
    'INSERT INTO usuarios (nombre, email, password, restaurante) VALUES ($1, $2, $3, $4)',
    [nombre, email, hash, restaurante]
  );
  res.redirect('/login');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.post('/llamada', async (req, res) => {
  const callSid = req.body.CallSid;
  const telefono = req.body.From || callSid;
  const hoy = new Date().toISOString().split('T')[0];

  const contexto = await obtenerContextoCliente(telefono);
  conversaciones[callSid] = [
    { role: 'system', content: SYSTEM_PROMPT(hoy, contexto) }
  ];

  const saludo = contexto && contexto.cliente && contexto.cliente.nombre
    ? `Hola ${contexto.cliente.nombre}, soy Mario. En que puedo ayudarte?`
    : 'Hola, soy Mario, el asistente del restaurante. En que puedo ayudarte?';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="5">
    <Say language="es-ES">${saludo}</Say>
  </Gather>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

app.post('/responder', async (req, res) => {
  const callSid = req.body.CallSid;
  const telefono = req.body.From || callSid;
  const textoCliente = req.body.SpeechResult || '';
  console.log('Cliente dijo:', textoCliente);

  const hoy = new Date().toISOString().split('T')[0];
  const contexto = await obtenerContextoCliente(telefono);

  if (!conversaciones[callSid]) {
    conversaciones[callSid] = [
      { role: 'system', content: SYSTEM_PROMPT(hoy, contexto) }
    ];
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
    mensaje = await procesarAccion(datos, callSid, contexto, telefono);
    if (mensaje.includes('confirmada') || mensaje.includes('cancelada') || mensaje.includes('modificada')) {
      const nuevoContexto = await obtenerContextoCliente(telefono);
      conversaciones[callSid] = [
        { role: 'system', content: SYSTEM_PROMPT(hoy, nuevoContexto) },
        { role: 'assistant', content: mensaje }
      ];
    }
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="5">
    <Say language="es-ES">${mensaje}</Say>
  </Gather>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

app.post('/whatsapp', async (req, res) => {
  try {
    const from = req.body.From;
    const mensaje = req.body.Body;
    console.log('1. Mensaje recibido:', from, mensaje);

    const hoy = new Date().toISOString().split('T')[0];
    console.log('2. Obteniendo contexto...');
    const contexto = await obtenerContextoCliente(from);
    console.log('3. Contexto obtenido');

    if (!conversacionesWhatsapp[from]) {
      conversacionesWhatsapp[from] = [
        { role: 'system', content: SYSTEM_PROMPT(hoy, contexto) }
      ];
    }

    conversacionesWhatsapp[from].push({ role: 'user', content: mensaje });
    console.log('4. Llamando a OpenAI...');

    const respuestaIA = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: conversacionesWhatsapp[from]
    });

    let respuesta = respuestaIA.choices[0].message.content;
    console.log('5. Respuesta IA:', respuesta);

    conversacionesWhatsapp[from].push({ role: 'assistant', content: respuesta });

    if (respuesta.toLowerCase().includes('un momento por favor')) {
      const datos = await extraerDatosReserva(conversacionesWhatsapp[from]);
      respuesta = await procesarAccion(datos, from, contexto, from);
      if (respuesta.includes('confirmada') || respuesta.includes('cancelada') || respuesta.includes('modificada')) {
        const nuevoContexto = await obtenerContextoCliente(from);
        conversacionesWhatsapp[from] = [
          { role: 'system', content: SYSTEM_PROMPT(hoy, nuevoContexto) },
          { role: 'assistant', content: respuesta }
        ];
      }
    }

    console.log('6. Enviando respuesta:', respuesta);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${respuesta}</Message>
</Response>`;

    console.log('7. TwiML listo');
    res.type('text/xml');
    res.send(twiml);
    console.log('8. Respuesta enviada');

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

app.get('/api/reservas', async (req, res) => {
  const resultado = await db.query('SELECT * FROM reservas ORDER BY creada_en DESC');
  res.json(resultado.rows);
});

app.post('/cancelar/:id', requireLogin, async (req, res) => {
  await db.query('DELETE FROM reservas WHERE id = $1', [req.params.id]);
  res.redirect('/panel');
});

app.post('/nueva-reserva', requireLogin, async (req, res) => {
  const { nombre, fecha, hora, personas } = req.body;

  const ahora = new Date();
  const fechaHoraReserva = new Date(`${fecha}T${hora}`);

  if (fechaHoraReserva <= ahora) {
    return res.redirect('/panel?error=fecha');
  }

  const disponibilidad = await hayDisponibilidad(fecha, hora, parseInt(personas));
  if (!disponibilidad.disponible) {
    return res.redirect('/panel?error=cupo');
  }

 await db.query(
    'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas, telefono_cliente, usuario_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    ['manual', nombre, fecha, hora, parseInt(personas), 'manual', req.session.usuario.id]
  );
  res.redirect('/panel');
});

app.listen(3000, () => {
  console.log('Servidor escuchando en puerto 3000');
});