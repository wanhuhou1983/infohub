// 检查数据库中图片 URL 格式
import postgres from 'postgres';

const sql = postgres('postgres://infohub:infohub123@localhost:5433/infohub');

try {
  const rows = await sql`SELECT id, source_type FROM articles WHERE content LIKE '%/api/images/%' LIMIT 10`;
  console.log('DB中含 /api/images/ 的文章:', rows.length, '篇');
  for (const r of rows) console.log('  id:', r.id, 'source:', r.source_type);

  const cosRows = await sql`SELECT id, source_type FROM articles WHERE content LIKE '%wanhuhou-1300445858.cos%' LIMIT 10`;
  console.log('\nDB中含 COS URL 的文章:', cosRows.length, '篇');
  for (const r of cosRows) console.log('  id:', r.id, 'source:', r.source_type);
} finally {
  await sql.end();
}
