// Prints the migration SQL so you can paste it into Supabase's SQL editor.
import { MIGRATIONS } from "../src/core/migrations.js";
for (const m of MIGRATIONS) console.log(`-- migration ${m.id}\n${m.sql}\n`);
