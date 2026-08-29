ALTER TABLE "memory_fragments" ADD COLUMN "valence" real DEFAULT 0 NOT NULL;
ALTER TABLE "memory_fragments" ADD COLUMN "arousal" real DEFAULT 0 NOT NULL;
ALTER TABLE "memory_fragments" ADD COLUMN "half_life_hours" real DEFAULT 24 NOT NULL;
ALTER TABLE "memory_fragments" ADD COLUMN "session_ids" jsonb DEFAULT '[]' NOT NULL;
ALTER TABLE "memory_fragments" ADD COLUMN "trigger_pattern" text;
ALTER TABLE "memory_fragments" ADD COLUMN "last_intruded_at" bigint;
