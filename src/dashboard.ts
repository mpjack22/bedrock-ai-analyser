import { QuotaService } from './lib/quotaService.js';
import { config } from './config.js';

async function dashboard() {
  const quotaService = new QuotaService();

  console.clear();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           AWS BEDROCK QUOTA DASHBOARD');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    const quotas = await quotaService.getBedrockQuotas();
    
    console.log(`Region: ${config.region}`);
    console.log(`Last Updated: ${new Date().toLocaleString()}\n`);

    console.log('QUOTAS:');
    console.log('───────────────────────────────────────────────────────────');
    
    for (const quota of quotas.slice(0, 15)) {
      const adjustable = quota.adjustable ? '✓' : '✗';
      console.log(`${adjustable} ${quota.quotaName}`);
      console.log(`  ${quota.value} ${quota.unit}`);
    }

    console.log('\n\nMODEL USAGE (Last 24 hours):');
    console.log('───────────────────────────────────────────────────────────');
    
    for (const modelId of config.models) {
      const invocations = await quotaService.getModelInvocationMetrics(modelId, 24);
      const shortName = modelId.split('.').pop() || modelId;
      console.log(`${shortName}: ${invocations} invocations`);
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    
  } catch (error) {
    console.error('Error generating dashboard:', error);
  }
}

dashboard().catch(console.error);
