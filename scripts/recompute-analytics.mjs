import { readFile } from 'node:fs/promises';
import { analyze } from '../src/analytics.ts';
const path=process.argv[2];
if(!path) { console.error('用法：npm run analytics:recompute -- /path/to/sop-analytics-bundle-v1.json'); process.exit(1); }
const bundle=JSON.parse(await readFile(path,'utf8'));
if(bundle.format!=='SOP Analytics Bundle'||bundle.schemaVersion!==1||!bundle.rawLog?.events) throw Error('不支持的 Bundle 格式');
const {events,...summary}=analyze(bundle.rawLog);
const matchesExportedSummary=JSON.stringify(summary)===JSON.stringify(bundle.summary);
console.log(JSON.stringify({matchesExportedSummary,summary},null,2));
if(!matchesExportedSummary) process.exitCode=1;
