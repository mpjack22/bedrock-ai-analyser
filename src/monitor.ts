import { QuotaService } from './lib/quotaService.js';
import { PredictionService } from './lib/predictionService.js';
import { AlertService } from './lib/alertService.js';
import { config } from './config.js';

async function monitor() {
  const quotaService = new QuotaService();
  const predictionService = new PredictionService();
  const alertService = new AlertService(config.alerts);

  console.log('🔍 Starting Bedrock AI Analyser...\n');
  console.log(`Region: ${config.region}`);
  console.log(`Monitoring interval: ${config.monitoringInterval / 1000}s`);
  console.log(`Alert threshold: ${config.alertThreshold}%\n`);

  async function checkQuotas() {
    console.log(`\n[${new Date().toISOString()}] Checking quotas...`);
    
    try {
      const quotas = await quotaService.getBedrockQuotas();
      
      console.log(`\nFound ${quotas.length} Bedrock quotas:\n`);
      
      for (const quota of quotas.slice(0, 10)) {
        console.log(`  ${quota.quotaName}`);
        console.log(`    Limit: ${quota.value} ${quota.unit}`);
        console.log(`    Adjustable: ${quota.adjustable ? 'Yes' : 'No'}`);
        console.log('');
      }

      const invocationQuota = quotas.find(q => 
        q.quotaName.toLowerCase().includes('invocation')
      );

      console.log('\nModel Usage & Predictions:');
      for (const modelId of config.models) {
        const invocations = await quotaService.getModelInvocationMetrics(modelId, 24);
        console.log(`  ${modelId}: ${invocations} invocations (24h)`);
        
        predictionService.addUsageData(modelId, {
          timestamp: new Date(),
          modelId,
          invocations,
          inputTokens: 0,
          outputTokens: 0,
        });

        if (invocationQuota) {
          const prediction = predictionService.predictExhaustion(
            modelId,
            invocationQuota.value
          );

          if (prediction.utilizationPercent > config.alertThreshold) {
            console.log(`    ⚠️ ${prediction.utilizationPercent.toFixed(1)}% utilization - Sending alert`);
            await alertService.sendAlert(prediction);
          }
        }
      }
      
    } catch (error) {
      console.error('Error during monitoring:', error);
    }
  }

  await checkQuotas();

  setInterval(checkQuotas, config.monitoringInterval);
}

monitor().catch(console.error);
