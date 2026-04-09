export interface QuotaInfo {
  quotaName: string;
  quotaCode: string;
  value: number;
  unit: string;
  adjustable: boolean;
}

export interface UsageMetric {
  timestamp: Date;
  modelId: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
}

export interface QuotaStatus {
  quotaName: string;
  current: number;
  limit: number;
  percentage: number;
  trend: 'increasing' | 'stable' | 'decreasing';
  estimatedDaysToLimit: number | null;
}

export interface PredictionResult {
  modelId: string;
  currentUsage: number;
  quotaLimit: number;
  utilizationPercent: number;
  predictedExhaustionDate: Date | null;
  recommendation: string;
}
