require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/llamada', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="5">
    <Say language="es-ES">
      Hola, bienvenido al restaurante. ¿En qué puedo ayudarte?
    </Say>
  </Gather>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

app.post('/responder', async (req, res) => {
  const textoCliente = req.body.SpeechResult || 'No entendí nada';
  console.log('Cliente dijo:', textoCliente);

  const respuestaIA = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Eres un asistente de reservas de restaurante. Ayuda al cliente a hacer una reserva preguntando su nombre, fecha, hora y número de personas. Sé amable y breve.' },
      { role: 'user', content: textoCliente }
    ]
  });

  const mensaje = respuestaIA.choices[0].message.content;
  console.log('Bot responde:', mensaje);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" language="es-ES" action="/responder" method="POST" timeout="5">
    <Say language="es-ES">${mensaje}</Say>
  </Gather>
</Response>`;
  res.type('text/xml');
  res.send(twiml);
});

app.listen(3000, () => {
  console.log('Servidor escuchando en puerto 3000');
});