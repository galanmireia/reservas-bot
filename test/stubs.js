// Stubs de APIs externas para TEST_MODE.
// Reemplazan a OpenAI, ElevenLabs, Deepgram, Twilio y Resend con fakes
// que NO hacen llamadas de red ni gastan dinero.
//
// Además expone una BD en memoria (pg-mem) compatible con la interfaz de pg.Pool.

const { newDb } = require('pg-mem');

// ---------- Cola de respuestas controladas desde /test ----------
const chatReplyQueue = [];
const extractJsonQueue = [];

function queueChatReply(text) { chatReplyQueue.push(String(text)); }
function queueExtractJson(obj) { extractJsonQueue.push(obj); }
function clearQueues() { chatReplyQueue.length = 0; extractJsonQueue.length = 0; }
function peekChatQueue() { return chatReplyQueue.length; }
function peekJsonQueue() { return extractJsonQueue.length; }

// Heurística mínima: si no hay respuesta encolada, intenta detectar
// el tipo de petición y devolver algo sensato para no romper el flujo.
function fallbackChatReply(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const wantsJson = /JSON/i.test(lastUser) || /extrae los datos/i.test(lastUser);
  if (wantsJson) {
    return JSON.stringify({
      accion: null, nombre: null, fecha: null, hora: null, personas: null,
      notas: null, nueva_fecha: null, nueva_hora: null, nuevas_personas: null
    });
  }
  return '(stub LLM) No tengo respuesta encolada. Usá /test/llm-next desde el panel.';
}

const openai = {
  chat: {
    completions: {
      create: async ({ messages }) => {
        const ultimoUsuario = [...messages].reverse().find(m => m.role === 'user')?.content || '';
        const pideJson = /extrae los datos/i.test(ultimoUsuario) || /JSON/.test(ultimoUsuario);

        let content;
        if (pideJson) {
          if (extractJsonQueue.length > 0) {
            content = JSON.stringify(extractJsonQueue.shift());
          } else {
            content = fallbackChatReply(messages);
          }
        } else {
          if (chatReplyQueue.length > 0) {
            content = chatReplyQueue.shift();
          } else {
            content = fallbackChatReply(messages);
          }
        }
        return { choices: [{ message: { content } }] };
      }
    }
  }
};

// ---------- ElevenLabs stub ----------
const elevenlabs = {
  textToSpeech: {
    convert: async () => {
      // Devuelve un buffer vacío como si fuese audio.
      return {
        arrayBuffer: async () => new ArrayBuffer(0)
      };
    }
  }
};

// ---------- Twilio stub ----------
const twilioClient = {
  messages: {
    create: async ({ from, to, body }) => {
      console.log(`📲 [stub Twilio] WhatsApp ${from} → ${to}: ${body?.slice(0, 80)}...`);
      return { sid: 'SMtest' + Date.now() };
    }
  }
};

// ---------- Resend stub ----------
const resend = {
  emails: {
    send: async ({ to, subject }) => {
      console.log(`✉️  [stub Resend] Email → ${to}: ${subject}`);
      return { id: 'em_test_' + Date.now() };
    }
  }
};

// ---------- Base de datos en memoria (pg-mem) ----------
function buildDb() {
  const mem = newDb({ autoCreateForeignKeyIndices: true });

  // pg-mem no soporta CURRENT_DATE/NOW() en todos los contextos, pero los básicos sí.
  // Registramos funciones que el código usa.
  mem.public.registerFunction({
    name: 'mode',
    args: [],
    returns: 'text',
    implementation: () => null
  });

  const adapter = mem.adapters.createPg();
  // adapter.Pool tiene la misma interfaz que pg.Pool.
  const pool = new adapter.Pool();
  return { mem, pool };
}

const { pool: db, mem } = buildDb();

// Esquema. Lo aplicamos al primer arranque (initDb) y en cada reset.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre TEXT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  restaurante TEXT,
  rol TEXT,
  numero_twilio TEXT,
  creado_en TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS configuracion (
  id SERIAL PRIMARY KEY,
  usuario_id INT UNIQUE,
  restaurante TEXT,
  telefono TEXT,
  direccion TEXT,
  horario TEXT,
  aparcamiento TEXT,
  menu TEXT,
  especialidad TEXT
);

CREATE TABLE IF NOT EXISTS mesas (
  id SERIAL PRIMARY KEY,
  numero INT,
  capacidad INT,
  usuario_id INT
);

CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  telefono TEXT UNIQUE,
  nombre TEXT,
  ultima_visita TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservas (
  id SERIAL PRIMARY KEY,
  call_sid TEXT,
  nombre TEXT,
  fecha DATE,
  hora TIME,
  personas INT,
  telefono_cliente TEXT,
  usuario_id INT,
  canal TEXT,
  notas TEXT,
  estado TEXT DEFAULT 'confirmada',
  creada_en TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lista_espera (
  id SERIAL PRIMARY KEY,
  usuario_id INT,
  telefono TEXT,
  nombre TEXT,
  fecha DATE,
  hora TIME,
  personas INT,
  creada_en TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dias_cerrados (
  id SERIAL PRIMARY KEY,
  usuario_id INT,
  fecha DATE,
  fecha_fin DATE,
  motivo TEXT,
  tipo TEXT,
  dia_semana INT
);
`;

async function applySchema(pool) {
  for (const stmt of SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
}

async function seed(pool) {
  // Hash de "test" pregenerado con bcrypt rounds=10
  // (no usamos bcrypt aquí para no bloquear; lo generamos en initDb)
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('test', 10);
  const adminHash = await bcrypt.hash('admin', 10);

  await pool.query(
    `INSERT INTO usuarios (nombre, email, password, restaurante, rol)
     VALUES ($1, $2, $3, $4, $5)`,
    ['Restaurante de Prueba', 'test@test.com', hash, 'La Trattoria Test', 'usuario']
  );
  await pool.query(
    `INSERT INTO usuarios (nombre, email, password, restaurante, rol)
     VALUES ($1, $2, $3, $4, $5)`,
    ['Admin', 'admin@test.com', adminHash, 'Admin', 'admin']
  );
  const uid = (await pool.query("SELECT id FROM usuarios WHERE email = 'test@test.com'")).rows[0].id;

  await pool.query(
    `INSERT INTO configuracion (usuario_id, restaurante, telefono, direccion, horario, menu, especialidad)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [uid, 'La Trattoria Test', '+34910000000', 'Calle Falsa 123, Madrid',
     'Mediodía 13:00–16:00, Noche 20:00–23:30',
     'Pizza, pasta fresca, ensaladas, postres caseros',
     'Pizza napolitana al horno de leña']
  );

  // 4 mesas: 2 de 2, 1 de 4, 1 de 6
  await pool.query('INSERT INTO mesas (numero, capacidad, usuario_id) VALUES ($1,$2,$3)', [1, 2, uid]);
  await pool.query('INSERT INTO mesas (numero, capacidad, usuario_id) VALUES ($1,$2,$3)', [2, 2, uid]);
  await pool.query('INSERT INTO mesas (numero, capacidad, usuario_id) VALUES ($1,$2,$3)', [3, 4, uid]);
  await pool.query('INSERT INTO mesas (numero, capacidad, usuario_id) VALUES ($1,$2,$3)', [4, 6, uid]);
}

async function initDb(pool) {
  await applySchema(pool);
  await seed(pool);
}

async function resetDb(pool) {
  await pool.query('DROP TABLE IF EXISTS reservas');
  await pool.query('DROP TABLE IF EXISTS lista_espera');
  await pool.query('DROP TABLE IF EXISTS clientes');
  await pool.query('DROP TABLE IF EXISTS dias_cerrados');
  await pool.query('DROP TABLE IF EXISTS mesas');
  await pool.query('DROP TABLE IF EXISTS configuracion');
  await pool.query('DROP TABLE IF EXISTS usuarios');
  await initDb(pool);
}

module.exports = {
  openai,
  elevenlabs,
  twilioClient,
  resend,
  db,
  initDb,
  resetDb,
  queueChatReply,
  queueExtractJson,
  clearQueues,
  peekChatQueue,
  peekJsonQueue
};
