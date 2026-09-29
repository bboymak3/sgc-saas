-- Un cliente puede conversar con varios negocios: la unicidad pasa de
-- (phone) a (phone, tenant_id). Sin esto, el INSERT de la conversación
-- falla cuando un número que ya habló con un tenant escribe a otro.
--
-- sgc_cit_WhatsApp_messages tiene una FOREIGN KEY hacia las conversaciones,
-- así que se reconstruyen ambas: la tabla nueva de mensajes referencia a la
-- tabla nueva de conversaciones y, al renombrarla, SQLite actualiza la FK.
-- Así nunca hay filas huérfanas (DROP TABLE del padre con hijos vivos falla
-- aunque se use defer_foreign_keys).

CREATE TABLE sgc_cit_WhatsApp_conversations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  contact_name TEXT,
  last_message_at TEXT DEFAULT (datetime('now','-3 hours')),
  last_user_message TEXT,
  last_bot_message TEXT,
  client_context TEXT,
  total_messages INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','-3 hours')),
  tenant_id INTEGER NOT NULL DEFAULT 1,
  UNIQUE (phone, tenant_id)
);

CREATE TABLE sgc_cit_WhatsApp_messages_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_used TEXT,
  tool_input TEXT,
  tool_result TEXT,
  created_at TEXT DEFAULT (datetime('now','-3 hours')),
  tenant_id INTEGER DEFAULT 1,
  FOREIGN KEY (conversation_id) REFERENCES sgc_cit_WhatsApp_conversations_new(id)
);

INSERT INTO sgc_cit_WhatsApp_conversations_new
  (id, phone, contact_name, last_message_at, last_user_message, last_bot_message, client_context, total_messages, status, created_at, tenant_id)
SELECT id, phone, contact_name, last_message_at, last_user_message, last_bot_message, client_context, total_messages, status, created_at, COALESCE(tenant_id, 1)
FROM sgc_cit_WhatsApp_conversations;

INSERT INTO sgc_cit_WhatsApp_messages_new
  (id, conversation_id, direction, content, tool_used, tool_input, tool_result, created_at, tenant_id)
SELECT m.id, m.conversation_id, m.direction, m.content, m.tool_used, m.tool_input, m.tool_result, m.created_at, COALESCE(c.tenant_id, m.tenant_id, 1)
FROM sgc_cit_WhatsApp_messages m
JOIN sgc_cit_WhatsApp_conversations c ON c.id = m.conversation_id;

DROP TABLE sgc_cit_WhatsApp_messages;
DROP TABLE sgc_cit_WhatsApp_conversations;
ALTER TABLE sgc_cit_WhatsApp_conversations_new RENAME TO sgc_cit_WhatsApp_conversations;
ALTER TABLE sgc_cit_WhatsApp_messages_new RENAME TO sgc_cit_WhatsApp_messages;

CREATE INDEX IF NOT EXISTS idx_wa_conv_phone ON sgc_cit_WhatsApp_conversations(phone);
CREATE INDEX IF NOT EXISTS idx_sgc_cit_WhatsApp_conversations_tenant ON sgc_cit_WhatsApp_conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON sgc_cit_WhatsApp_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sgc_cit_WhatsApp_messages_tenant ON sgc_cit_WhatsApp_messages(tenant_id);
