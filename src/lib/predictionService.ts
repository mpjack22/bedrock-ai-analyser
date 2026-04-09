import type { UsageMetric, PredictionResult } from '../types/index.js';
import { config } from '../config.js';

export class PredictionService {
  private usageHistory: Map<string, UsageMetric[]> = new Map();

  addUsageData(modelId: string, metric: UsageMetric): void {
    if (!this.usageHistory.has(modelId)) {
      this.usageHistory.set(modelId, []);
    }
    
    const history = this.usageHistory.get(modelId)!;
    history.push(metric);
    
    const cutoff = new Date(Date.now() - config.dataRetention * 24 * 60 * 60 * 1000);
    this.usageHistory.set(
      modelId,
      history.filter(m => m.timestamp >= cutoff)
    );
  }

  predictExhaustion(modelId: string, quotaLimit: number): PredictionResult {
    const history = this.usageHistory.get(modelId) || [];
    
    if (history.length < 2) {
      return {
        modelId,
        currentUsage: 0,
        quotaLimit,
        utilizationPercent: 0,
        predictedExhaustionDate: null,
        recommendation: 'Insufficient data for prediction',
      };
    }

    const currentUsage = history[history.length - 1].invocations;
    const utilizationPercent = (currentUsage / quotaLimit) * 100;
    
    const recentData = history.slice(-7);
    const avgDailyIncrease = this.calculateDailyIncrease(recentData);
    
    let predictedExhaustionDate: Date | null = null;
    let recommendation = '';
    
    if (avgDailyIncrease > 0) {
      const remainingQuota = quotaLimit - currentUsage;
      const daysToExhaustion = remainingQuota / avgDailyIncrease;
      
      if (daysToExhaustion > 0 && daysToExhaustion < config.predictionWindow) {
        predictedExhaustionDate = new Date(Date.now() + daysToExhaustion * 24 * 60 * 60 * 1000);
        recommendation = `⚠️ Quota may be exhausted in ${Math.ceil(daysToExhaustion)} days. Consider requesting an increase.`;
      } else if (utilizationPercent > config.alertThreshold) {
        recommendation = `⚠️ Usage at ${utilizationPercent.toFixed(1)}%. Monitor closely.`;
      } else {
        recommendation = '✓ Usage within normal limits';
      }
    } else {
      recommendation = '✓ Usage stable or decreasing';
    }

    return {
      modelId,
      currentUsage,
      quotaLimit,
      utilizationPercent,
      predictedExhaustionDate,
      recommendation,
    };
  }

  private calculateDailyIncrease(metrics: UsageMetric[]): number {
    if (metrics.length < 2) return 0;
    
    const first = metrics[0];
    const last = metrics[metrics.length - 1];
    const daysDiff = (last.timestamp.getTime() - first.timestamp.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysDiff === 0) return 0;
    
    return (last.invocations - first.invocations) / daysDiff;
  }
}
