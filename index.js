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

async function hayDisponibilidad(fecha, hora, personas) {
  if (personas > 4) return { disponible: false, motivo: 'No tenemos mesas para más de 4 personas.' };

  const capacidadNecesaria = personas <= 2 ? 2 : 4;

  const mesasAdecuadas = await db.query(
    'SELECT id FROM mesas WHERE capacidad = $1',
    [capacidadNecesaria]
  );

  const [horaH, horaM] = hora.split(':').map(Number);
  const horaInicio = `${String(horaH - 1).padStart(2, '0')}:${String(horaM).padStart(2, '0')}`;
  const horaFin = `${String(horaH + 1).padStart(2, '0')}:${String(horaM).padStart(2, '0')}`;

  const reservasOcupadas = await db.query(
    `SELECT COUNT(*) FROM reservas 
     WHERE fecha = $1 
     AND hora >= $2 
     AND hora <= $3
     AND personas > $4`,
    [fecha, horaInicio, horaFin, capacidadNecesaria === 2 ? 0 : 2]
  );

  const totalMesas = mesasAdecuadas.rows.length;
  const ocupadas = parseInt(reservasOcupadas.rows[0].count);

  console.log(`Mesas ${capacidadNecesaria}p: ${totalMesas} total, ${ocupadas} ocupadas en rango ${horaInicio}-${horaFin}`);

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
      { role: 'user', content: `Extrae los datos de la reserva en formato JSON con estos campos: nombre, fecha, hora, personas. La fecha debe estar en formato YYYY-MM-DD usando como referencia que hoy es ${new Date().toISOString().split('T')[0]}. La hora en formato HH:MM. Si algún dato falta pon null. Responde SOLO con el JSON, sin texto adicional, sin comillas de código.` }
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
  const hoy = new Date().toISOString().split('T')[0];
  conversaciones[callSid] = [
    { role: 'system', content: `Eres un asistente de reservas de restaurante llamado Mario. La fecha de hoy es ${hoy}. Ayuda al cliente a hacer una reserva preguntando su nombre, fecha, hora y número de personas. Sé amable y breve. No confirmes la reserva hasta que el sistema la valide. Cuando tengas todos los datos di EXACTAMENTE: "un momento por favor" y espera.` }
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

  const hoy = new Date().toISOString().split('T')[0];

  if (!conversaciones[callSid]) {
    conversaciones[callSid] = [
      { role: 'system', content: `Eres un asistente de reservas de restaurante llamado Mario. La fecha de hoy es ${hoy}. Ayuda al cliente a hacer una reserva preguntando su nombre, fecha, hora y número de personas. Sé amable y breve.` }
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

    if (datos && datos.nombre && datos.fecha && datos.hora && datos.personas) {
      const fechaReserva = new Date(`${datos.fecha}T${datos.hora}`);
      const ahora = new Date();

      if (fechaReserva <= ahora) {
        mensaje = 'Lo siento, esa fecha y hora ya han pasado. ¿Para qué otra fecha o hora te gustaría hacer la reserva?';
      } else {
        const disponibilidad = await hayDisponibilidad(datos.fecha, datos.hora, datos.personas);

        if (!disponibilidad.disponible) {
          mensaje = `Lo siento, ${disponibilidad.motivo} ¿Te gustaría reservar para otra hora o fecha?`;
        } else {
          await db.query(
            'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas) VALUES ($1, $2, $3, $4, $5)',
            [callSid, datos.nombre, datos.fecha, datos.hora, datos.personas]
          );
          console.log('Reserva guardada:', datos);
          mensaje = `Perfecto ${datos.nombre}, tu reserva está confirmada para el ${datos.fecha} a las ${datos.hora} para ${datos.personas} personas. ¡Te esperamos!`;
        }
      }
    } else {
      mensaje = 'Disculpa, necesito tu nombre, fecha, hora y número de personas para completar la reserva. ¿Puedes repetírmelos?';
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
  const error = req.query.error || null;
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
    fechaFiltro,
    error
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

app.post('/nueva-reserva', async (req, res) => {
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
    'INSERT INTO reservas (call_sid, nombre, fecha, hora, personas) VALUES ($1, $2, $3, $4, $5)',
    ['manual', nombre, fecha, hora, parseInt(personas)]
  );
  res.redirect('/panel');
});

app.listen(3000, () => {
  console.log('Servidor escuchando en puerto 3000');
});