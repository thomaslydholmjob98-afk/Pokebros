const fs=require('fs'); const {Pool}=require('pg');
if(!process.env.DATABASE_URL){console.error('DATABASE_URL mangler');process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DB_SSL==='false'?false:{rejectUnauthorized:false}});
(async()=>{try{await pool.query(fs.readFileSync('schema.sql','utf8'));console.log('Database klar.');}finally{await pool.end()}})().catch(e=>{console.error(e);process.exit(1)});
