import { QuotaService } from './lib/quotaService.js';
import { config } from './config.js';

async function main() {
  console.log('Bedrock AI Analyser');
  console.log('Run with: npm run monitor, npm run predict, or npm run dashboard');
}

main().catch(console.error);
