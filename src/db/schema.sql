-- Pichanga 2026 - esquema relacional
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  short_name TEXT,
  division TEXT NOT NULL CHECK (division IN ('Primera A', 'Primera B')),
  city TEXT,
  stadium TEXT,
  crest_url TEXT,
  founded_year INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  budget INTEGER NOT NULL DEFAULT 0,       -- presupuesto de fichajes, en miles de USD
  last_budget_topup TEXT                   -- clave "temporada-ventana" del ultimo refuerzo de presupuesto
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  birth_date TEXT,              -- ISO date; edad se calcula contra la temporada actual
  nationality TEXT NOT NULL,
  position TEXT NOT NULL CHECK (position IN ('Portero', 'Defensa', 'Mediocampista', 'Delantero')),
  shirt_number INTEGER,
  rating INTEGER NOT NULL DEFAULT 60 CHECK (rating BETWEEN 1 AND 99),
  potential INTEGER NOT NULL DEFAULT 60 CHECK (potential BETWEEN 1 AND 99),
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'lesionado', 'retirado', 'sin_club')),
  is_real_player INTEGER NOT NULL DEFAULT 1, -- 0 = generado (juvenil/futuro), nunca se hace pasar por jugador real
  source_url TEXT,              -- referencia de donde se obtuvieron los datos reales
  retired_at_season INTEGER,
  retired_age INTEGER,
  created_at_season INTEGER NOT NULL DEFAULT 2026,
  loaned_from_club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL, -- club dueño mientras el jugador esta a préstamo en club_id
  loan_return_season INTEGER                                          -- temporada en que vuelve a loaned_from_club_id
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL UNIQUE,
  is_current INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS player_season_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_year INTEGER NOT NULL,
  club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
  matches_played INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards INTEGER NOT NULL DEFAULT 0,
  UNIQUE(player_id, season_year)
);

CREATE TABLE IF NOT EXISTS injuries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_year INTEGER NOT NULL,
  injury_type TEXT NOT NULL CHECK (injury_type IN ('Muscular', 'Esguince', 'Rodilla', 'Fractura')),
  severity TEXT NOT NULL CHECK (severity IN ('Leve', 'Moderada', 'Grave', 'Muy grave')),
  weeks_out INTEGER NOT NULL,
  weeks_remaining INTEGER NOT NULL,
  is_relapse INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_year INTEGER NOT NULL,
  from_club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
  to_club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('fichaje', 'venta', 'prestamo', 'retiro', 'generacion_juvenil')),
  fee_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS player_history_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_year INTEGER NOT NULL,
  event_type TEXT NOT NULL, -- 'lesion', 'retiro', 'fichaje', 'titulo', 'debut', 'ascenso_juvenil'
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS club_titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  season_year INTEGER NOT NULL,
  title_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fixtures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  division TEXT NOT NULL CHECK (division IN ('Primera A', 'Primera B')),
  jornada INTEGER NOT NULL,
  home_club_id INTEGER NOT NULL REFERENCES clubs(id),
  away_club_id INTEGER NOT NULL REFERENCES clubs(id),
  home_goals INTEGER,
  away_goals INTEGER,
  played INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS copa_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  round_name TEXT NOT NULL,
  round_order INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  home_club_id INTEGER REFERENCES clubs(id),
  away_club_id INTEGER REFERENCES clubs(id),
  home_goals INTEGER,
  away_goals INTEGER,
  played INTEGER NOT NULL DEFAULT 0,
  decided_by_penalties INTEGER NOT NULL DEFAULT 0,
  winner_club_id INTEGER REFERENCES clubs(id)
);

CREATE TABLE IF NOT EXISTS super_copa_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL UNIQUE,
  home_club_id INTEGER REFERENCES clubs(id),
  away_club_id INTEGER REFERENCES clubs(id),
  home_goals INTEGER,
  away_goals INTEGER,
  played INTEGER NOT NULL DEFAULT 0,
  decided_by_penalties INTEGER NOT NULL DEFAULT 0,
  winner_club_id INTEGER REFERENCES clubs(id),
  skipped_reason TEXT
);

CREATE TABLE IF NOT EXISTS career (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  club_id INTEGER REFERENCES clubs(id),
  manager_name TEXT,
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo', 'despedido')),
  hired_season INTEGER,
  objective_text TEXT,
  objective_season INTEGER,
  objective_kind TEXT,
  objective_target INTEGER,
  fired_season INTEGER,
  fired_reason TEXT,
  lineup_formation TEXT,      -- formacion preferida actual (editor tactico / ultima planilla usada)
  lineup_players TEXT,        -- JSON: ids de los 11 titulares, en el mismo orden que los slots de la formacion
  board_confidence INTEGER NOT NULL DEFAULT 60,   -- DIRIGENCIA: confianza de la dirigencia (0-100)
  locker_room_morale INTEGER NOT NULL DEFAULT 60, -- CAMARIN: confianza/ambiente del vestuario (0-100)
  fan_support INTEGER NOT NULL DEFAULT 60,        -- HINCHADA: apoyo y satisfaccion de los hinchas (0-100)
  manager_reputation INTEGER NOT NULL DEFAULT 60, -- reputacion del entrenador (0-100)
  matches_managed INTEGER NOT NULL DEFAULT 0,     -- partidos dirigidos en total, usado para espaciar acontecimientos
  last_reunion_at INTEGER NOT NULL DEFAULT 0,
  last_exigencia_at INTEGER NOT NULL DEFAULT 0,
  last_polemica_at INTEGER NOT NULL DEFAULT 0,
  last_clasico_at INTEGER NOT NULL DEFAULT 0,
  last_hinchada_at INTEGER NOT NULL DEFAULT 0
);

-- Acontecimientos y relaciones de la carrera: reuniones con la dirigencia,
-- exigencias, polemicas internas y clasicos, cada uno con opciones de
-- decision para el usuario y consecuencias sobre moral/confianza/reputacion.
CREATE TABLE IF NOT EXISTS career_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  match_count INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reunion', 'exigencia', 'polemica', 'clasico', 'hinchada')),
  subtype TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  options TEXT NOT NULL,       -- JSON: [{id, label, moraleDelta, confidenceDelta, reputationDelta}]
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'resuelto')),
  chosen_option TEXT,
  result_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_career_events_status ON career_events(status, id DESC);

CREATE TABLE IF NOT EXISTS board_meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  message TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('cumplido', 'incumplido', 'nuevo')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Registro corto de las ofertas que el usuario envio durante la ventana de
-- mercado actual (fichajes de agente libre, ofertas por jugadores de otros
-- clubes, solicitudes de prestamo), con el resultado de la negociacion, para
-- mostrar un panel compacto de "Ofertas enviadas" en la pantalla de mercado.
-- player_id + resolved sirven para las contraofertas de 'fichaje': quedan
-- apuntando al jugador y con resolved = 0 hasta que el usuario acepta o
-- rechaza la contraoferta desde el panel "Ofertas enviadas".
CREATE TABLE IF NOT EXISTS sent_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  window TEXT NOT NULL,
  player_id INTEGER REFERENCES players(id),
  player_name TEXT NOT NULL,
  target_club_name TEXT,
  amount INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('agente_libre', 'fichaje', 'prestamo')),
  status TEXT NOT NULL CHECK (status IN ('aceptada', 'rechazada', 'contraoferta')),
  resolved INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  reason TEXT NOT NULL CHECK (reason IN ('despido', 'buen_trabajo')),
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aceptada', 'rechazada', 'expirada')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS free_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('verano', 'invierno')),
  full_name TEXT NOT NULL,
  birth_date TEXT,
  nationality TEXT NOT NULL,
  position TEXT NOT NULL CHECK (position IN ('Portero', 'Defensa', 'Mediocampista', 'Delantero')),
  rating INTEGER NOT NULL,
  potential INTEGER NOT NULL,
  asking_price INTEGER NOT NULL,
  signed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transfer_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('verano', 'invierno')),
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  buyer_club_id INTEGER NOT NULL REFERENCES clubs(id),
  offer_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aceptada', 'rechazada', 'expirada')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_free_agents_window ON free_agents(season_year, window, signed);
CREATE INDEX IF NOT EXISTS idx_transfer_offers_player ON transfer_offers(player_id, status);

-- Panel de MEDIOS: opiniones ficticias generadas por la simulacion sobre los
-- partidos y fichajes del club que dirige el usuario (nunca declaraciones
-- reales de las personas en las que se inspiran los personajes).
CREATE TABLE IF NOT EXISTS media_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('partido', 'fichaje')),
  headline TEXT NOT NULL,
  borghi_text TEXT NOT NULL,
  tezanos_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_media_comments_season ON media_comments(season_year, id DESC);

-- Copa de la Liga: 4 grupos de 4 equipos de Primera A, luego semifinales ida
-- y vuelta entre los campeones de grupo y una final a partido unico en sede
-- neutral. Da el cupo Chile 3 de Copa Libertadores (fase previa).
CREATE TABLE IF NOT EXISTS copa_liga_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  club_id INTEGER NOT NULL REFERENCES clubs(id)
);

CREATE TABLE IF NOT EXISTS copa_liga_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('grupos', 'semifinal', 'final')),
  group_name TEXT,
  tie_slot INTEGER NOT NULL DEFAULT 0,  -- que cruce de semifinal (0 o 1); sin uso en grupos/final
  leg INTEGER NOT NULL DEFAULT 0,       -- 1 o 2 en semifinal ida/vuelta; 0 en grupos y en la final
  home_club_id INTEGER NOT NULL REFERENCES clubs(id),
  away_club_id INTEGER NOT NULL REFERENCES clubs(id),
  home_goals INTEGER,
  away_goals INTEGER,
  played INTEGER NOT NULL DEFAULT 0,
  decided_by_penalties INTEGER NOT NULL DEFAULT 0,
  winner_club_id INTEGER REFERENCES clubs(id)
);

CREATE INDEX IF NOT EXISTS idx_copa_liga_groups_season ON copa_liga_groups(season_year);
CREATE INDEX IF NOT EXISTS idx_copa_liga_matches_season ON copa_liga_matches(season_year, stage);

-- Definicion por el cupo Chile 4 de Copa Libertadores: tercer lugar del
-- Campeonato Nacional (o el siguiente disponible, segun reasignacion) contra
-- el campeon de Copa Chile (o su finalista, segun reasignacion). El ganador
-- clasifica a Chile 4 (fase previa Libertadores); el perdedor, a
-- Sudamericana 4.
CREATE TABLE IF NOT EXISTS chile4_playoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,
  home_club_id INTEGER NOT NULL REFERENCES clubs(id),
  away_club_id INTEGER NOT NULL REFERENCES clubs(id),
  home_goals INTEGER,
  away_goals INTEGER,
  played INTEGER NOT NULL DEFAULT 0,
  decided_by_penalties INTEGER NOT NULL DEFAULT 0,
  winner_club_id INTEGER REFERENCES clubs(id)
);

CREATE INDEX IF NOT EXISTS idx_chile4_playoffs_season ON chile4_playoffs(season_year);

-- Clasificacion final a copas internacionales 2027+ (Libertadores/Sudamericana)
-- calculada a partir de los resultados de season_year. Nunca se recalcula ni
-- se modifica para una season_year ya cerrada.
CREATE TABLE IF NOT EXISTS international_qualifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_year INTEGER NOT NULL,       -- temporada que genera la clasificacion (ej. 2026)
  competition TEXT NOT NULL CHECK (competition IN ('Libertadores', 'Sudamericana')),
  slot_number INTEGER NOT NULL,       -- 1 a 4
  stage TEXT NOT NULL,                -- 'Fase de grupos' | 'Fase previa'
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  qualification_path TEXT NOT NULL,   -- descripcion de como clasifico
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(season_year, competition, slot_number)
);

CREATE INDEX IF NOT EXISTS idx_international_qual_season ON international_qualifications(season_year);

CREATE INDEX IF NOT EXISTS idx_fixtures_lookup ON fixtures(season_year, division, jornada);
CREATE INDEX IF NOT EXISTS idx_copa_lookup ON copa_matches(season_year, round_order);
CREATE INDEX IF NOT EXISTS idx_players_club ON players(club_id);
CREATE INDEX IF NOT EXISTS idx_players_status ON players(status);
CREATE INDEX IF NOT EXISTS idx_injuries_player ON injuries(player_id);
CREATE INDEX IF NOT EXISTS idx_stats_player ON player_season_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_history_player ON player_history_events(player_id);
