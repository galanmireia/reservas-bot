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

const conversaciones = {};

async function extraerDatosReserva(mensajes) {
  const respuesta = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      ...mensajes,
      { role: 'user', content: 'Extrae los datos de la reserva en formato JSON con estos campos: nombre, fecha, hora, personas. Si algún dato falta pon null. Responde SOLO con el JSON, sin texto adicional, sin comillas de código.' }
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

app.set('view engine', 'ejs');

app.post('/llamada', (req, res) => {
  const callSid = req.body.CallSid;
  conversaciones[callSid] = [
    { role: 'system', content: 'Eres un asistente de reservas de restaurante llamado Mario. Ayuda al cliente a hacer una reserva preguntando su nombre, fecha, hora y número de personas. Sé amable y breve. Cuando tengas todos los datos confírmalos al cliente y di reserva confirmada al final.' }
  ];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="5">
    <Say language="es-ES">Hola, soy Mario, el asistente de reservas. ¿En qué puedo ayudarte?</Say>
  </Gather>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

app.post('/responder', async (req, res) => {
  const callSid = req.body.CallSid;
  const textoCliente = req.body.SpeechResult || '';
  console.log('Cliente dijo:', textoCliente);

  if (!conversaciones[callSid]) {
    conversaciones[callSid] = [
      { role: 'system', content: 'Eres un asistente de reservas de restaurante llamado Mario. Ayuda al cliente a hacer una reserva preguntando su nombre, fecha, hora y número de personas. Sé amable y breve.' }
    ];
  }

  conversaciones[callSid].push({ role: 'user', content: textoCliente });

  const respuestaIA = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: conversaciones[callSid]
  });

  const mensaje = respuestaIA.choices[0].message.content;
  conversaciones[callSid].push({ role: 'assistant', content: mensaje });
  console.log('Mensaje completo:', mensaje);

  if (mensaje.toLowerCase().includes('confirmad')) {
    console.log('Detectada confirmacion, guardando reserva...');
    const datos = await extraerDatosReserva(conversaciones[callSid]);
    if (datos && datos.nombre) {
      await db.query(
        'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas) VALUES ($1, $2, $3, $4, $5)',
        [callSid, datos.nombre, datos.fecha, datos.hora, datos.personas]
      );
      console.log('Reserva guardada:', datos);
    } else {
      console.log('No se pudieron extraer los datos:', datos);
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

app.get('/panel', async (req, res) => {
  const fechaFiltro = req.query.fecha || null;
  const hoy = new Date().toISOString().split('T')[0];

  const todas = await db.query('SELECT * FROM reservas ORDER BY creada_en DESC');
  const hoyQuery = await db.query('SELECT * FROM reservas WHERE fecha = $1 ORDER BY hora ASC', [hoy]);

  let filtradas = [];
  if (fechaFiltro) {
    const filtroQuery = await db.query('SELECT * FROM reservas WHERE fecha = $1 ORDER BY hora ASC', [fechaFiltro]);
    filtradas = filtroQuery.rows;
  }

  res.render('reservas', {
    reservas: todas.rows,
    reservasHoy: hoyQuery.rows,
    reservasFiltradas: filtradas,
    fechaFiltro
  });
});

app.get('/api/reservas', async (req, res) => {
  const resultado = await db.query('SELECT * FROM reservas ORDER BY creada_en DESC');
  res.json(resultado.rows);
});

app.post('/cancelar/:id', async (req, res) => {
  await db.query('DELETE FROM reservas WHERE id = $1', [req.params.id]);
  res.redirect('/panel');
});

app.listen(3000, () => {
  console.log('Servidor escuchando en puerto 3000');
});