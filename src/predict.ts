import { QuotaService } from './lib/quotaService.js';
import { PredictionService } from './lib/predictionService.js';
import { config } from './config.js';

async function predict() {
  const quotaService = new QuotaService();
  const predictionService = new PredictionService();

  console.log('🔮 Bedrock Quota Prediction Analysis\n');

  try {
    const quotas = await quotaService.getBedrockQuotas();
    
    const invocationQuota = quotas.find(q => 
      q.quotaName.toLowerCase().includes('invocation')
    );

    if (!invocationQuota) {
      console.log('⚠️ Could not find invocation quota');
      return;
    }

    console.log(`Analyzing against quota: ${invocationQuota.quotaName}`);
    console.log(`Limit: ${invocationQuota.value} ${invocationQuota.unit}\n`);

    for (const modelId of config.models) {
      const invocations = await quotaService.getModelInvocationMetrics(modelId, 168);
      
      for (let i = 0; i < 7; i++) {
        predictionService.addUsageData(modelId, {
          timestamp: new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000),
          modelId,
          invocations: invocations * (0.7 + i * 0.05),
          inputTokens: 0,
          outputTokens: 0,
        });
      }

      const prediction = predictionService.predictExhaustion(
        modelId,
        invocationQuota.value
      );

      console.log(`\n${modelId}:`);
      console.log(`  Current Usage: ${prediction.currentUsage.toFixed(0)}`);
      console.log(`  Utilization: ${prediction.utilizationPercent.toFixed(1)}%`);
      if (prediction.predictedExhaustionDate) {
        console.log(`  Predicted Exhaustion: ${prediction.predictedExhaustionDate.toLocaleDateString()}`);
      }
      console.log(`  ${prediction.recommendation}`);
    }

  } catch (error) {
    console.error('Error during prediction:', error);
  }
}

predict().catch(console.error);
