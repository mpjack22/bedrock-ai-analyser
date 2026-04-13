import { ServiceQuotasClient, GetServiceQuotaCommand, ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';
import { CloudWatchClient, GetMetricStatisticsCommand, ListMetricsCommand, type Statistic } from '@aws-sdk/client-cloudwatch';
import { config } from '../config.js';
import type { QuotaInfo, QuotaStatus } from '../types/index.js';

export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
}

export interface ModelTimeSeries {
  modelId: string;
  invocations: TimeSeriesPoint[];
  inputTokens: TimeSeriesPoint[];
  outputTokens: TimeSeriesPoint[];
  latency: TimeSeriesPoint[];
  latencyP50: TimeSeriesPoint[];
  latencyP90: TimeSeriesPoint[];
  latencyP99: TimeSeriesPoint[];
  clientErrors: TimeSeriesPoint[];
  serverErrors: TimeSeriesPoint[];
  throttles: TimeSeriesPoint[];
}

export interface AgentTimeSeries {
  agentInvocations: TimeSeriesPoint[];
  agentLatency: TimeSeriesPoint[];
  agentLatencyP50: TimeSeriesPoint[];
  agentLatencyP90: TimeSeriesPoint[];
  agentLatencyP99: TimeSeriesPoint[];
  agentErrors: TimeSeriesPoint[];
  agentStepCount: TimeSeriesPoint[];
  kbRetrieveCount: TimeSeriesPoint[];
  kbRetrieveLatency: TimeSeriesPoint[];
  kbErrors: TimeSeriesPoint[];
  guardrailInvocations: TimeSeriesPoint[];
  guardrailInterventions: TimeSeriesPoint[];
}

export class QuotaService {
  private quotasClient: ServiceQuotasClient;
  private cloudwatchClient: CloudWatchClient;
  public readonly region: string;

  constructor(region?: string) {
    this.region = region || config.region;
    this.quotasClient = new ServiceQuotasClient({ region: this.region });
    this.cloudwatchClient = new CloudWatchClient({ region: this.region });
  }

  async getBedrockQuotas(): Promise<QuotaInfo[]> {
    const quotas: QuotaInfo[] = [];
    const serviceCodes = ['bedrock', 'bedrock-agent', 'bedrock-runtime'];
    
    for (const serviceCode of serviceCodes) {
      try {
        const command = new ListServiceQuotasCommand({
          ServiceCode: serviceCode,
        });
        
        const response = await this.quotasClient.send(command);
        
        if (response.Quotas) {
          for (const quota of response.Quotas) {
            quotas.push({
              quotaName: `[${serviceCode}] ${quota.QuotaName || 'Unknown'}`,
              quotaCode: quota.QuotaCode || '',
              value: quota.Value || 0,
              unit: quota.Unit || '',
              adjustable: quota.Adjustable || false,
            });
          }
        }
      } catch (error) {
        console.error(`Error fetching quotas for ${serviceCode}:`, error);
      }
    }
    
    return quotas;
  }

  async getModelInvocationMetrics(modelId: string, hours: number = 24): Promise<number> {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

      // Try both AWS/Bedrock and AWS/BedrockRuntime namespaces
      const namespaces = ['AWS/Bedrock', 'AWS/BedrockRuntime'];
      let totalInvocations = 0;

      for (const namespace of namespaces) {
        try {
          const command = new GetMetricStatisticsCommand({
            Namespace: namespace,
            MetricName: 'Invocations',
            Dimensions: [
              {
                Name: 'ModelId',
                Value: modelId,
              },
            ],
            StartTime: startTime,
            EndTime: endTime,
            Period: 3600,
            Statistics: ['Sum' as Statistic],
          });

          const response = await this.cloudwatchClient.send(command);
          
          if (response.Datapoints && response.Datapoints.length > 0) {
            totalInvocations += response.Datapoints.reduce((sum, dp) => sum + (dp.Sum || 0), 0);
          }
        } catch (error) {
          // Continue to next namespace if this one fails
        }
      }

      return totalInvocations;
    } catch (error) {
      console.error(`Error fetching metrics for ${modelId}:`, error);
    }
    
    return 0;
  }

  async getQuotaStatus(quotaCode: string): Promise<QuotaStatus | null> {
    try {
      const command = new GetServiceQuotaCommand({
        ServiceCode: 'bedrock',
        QuotaCode: quotaCode,
      });
      
      const response = await this.quotasClient.send(command);
      
      if (response.Quota) {
        return {
          quotaName: response.Quota.QuotaName || 'Unknown',
          current: 0,
          limit: response.Quota.Value || 0,
          percentage: 0,
          trend: 'stable',
          estimatedDaysToLimit: null,
        };
      }
    } catch (error) {
      console.error(`Error fetching quota status for ${quotaCode}:`, error);
    }
    
    return null;
  }

  async getModelTimeSeries(modelId: string, hours: number = 24): Promise<ModelTimeSeries> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);
    const period = hours <= 1 ? 300 : hours <= 12 ? 900 : hours <= 72 ? 3600 : 86400;

    const fetchMetric = async (
      metricName: string,
      stat: string,
    ): Promise<TimeSeriesPoint[]> => {
      const allPoints = new Map<string, number>();
      const isExtended = stat.startsWith('p');
      for (const namespace of ['AWS/Bedrock', 'AWS/BedrockRuntime']) {
        try {
          const params: any = {
            Namespace: namespace,
            MetricName: metricName,
            Dimensions: [{ Name: 'ModelId', Value: modelId }],
            StartTime: startTime,
            EndTime: endTime,
            Period: period,
          };
          if (isExtended) {
            params.ExtendedStatistics = [stat];
          } else {
            params.Statistics = [stat as Statistic];
          }
          const command = new GetMetricStatisticsCommand(params);
          const response = await this.cloudwatchClient.send(command);
          for (const dp of response.Datapoints || []) {
            const ts = dp.Timestamp?.toISOString() || '';
            let val = 0;
            if (isExtended && dp.ExtendedStatistics) {
              val = dp.ExtendedStatistics[stat] || 0;
            } else {
              val = (dp as any)[stat] || 0;
            }
            allPoints.set(ts, (allPoints.get(ts) || 0) + val);
          }
        } catch {
          // continue
        }
      }
      return Array.from(allPoints.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([timestamp, value]) => ({ timestamp, value }));
    };

    const [invocations, inputTokens, outputTokens, latency, latencyP50, latencyP90, latencyP99, clientErrors, serverErrors, throttles] = await Promise.all([
      fetchMetric('Invocations', 'Sum'),
      fetchMetric('InputTokenCount', 'Sum'),
      fetchMetric('OutputTokenCount', 'Sum'),
      fetchMetric('InvocationLatency', 'Average'),
      fetchMetric('InvocationLatency', 'p50'),
      fetchMetric('InvocationLatency', 'p90'),
      fetchMetric('InvocationLatency', 'p99'),
      fetchMetric('InvocationClientErrors', 'Sum'),
      fetchMetric('InvocationServerErrors', 'Sum'),
      fetchMetric('InvocationThrottles', 'Sum'),
    ]);

    return { modelId, invocations, inputTokens, outputTokens, latency, latencyP50, latencyP90, latencyP99, clientErrors, serverErrors, throttles };
  }

  async listActiveModels(): Promise<string[]> {
    const models = new Set<string>();
    const namespaces = ['AWS/Bedrock', 'AWS/BedrockRuntime'];
    for (const ns of namespaces) {
      try {
        const command = new ListMetricsCommand({
          Namespace: ns,
          MetricName: 'Invocations',
        });
        const response = await this.cloudwatchClient.send(command);
        for (const metric of response.Metrics || []) {
          const dim = metric.Dimensions?.find(d => d.Name === 'ModelId');
          if (dim?.Value) models.add(dim.Value);
        }
      } catch {
        // namespace may not have metrics
      }
    }
    return Array.from(models);
  }

  async getAgentMetrics(hours: number = 24): Promise<{ agentInvocations: number; knowledgeBaseQueries: number }> {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

      let agentInvocations = 0;
      let knowledgeBaseQueries = 0;

      // Get Agent invocations
      try {
        const agentCommand = new GetMetricStatisticsCommand({
          Namespace: 'AWS/Bedrock',
          MetricName: 'AgentInvocations',
          StartTime: startTime,
          EndTime: endTime,
          Period: 3600,
          Statistics: ['Sum' as Statistic],
        });

        const agentResponse = await this.cloudwatchClient.send(agentCommand);
        if (agentResponse.Datapoints && agentResponse.Datapoints.length > 0) {
          agentInvocations = agentResponse.Datapoints.reduce((sum, dp) => sum + (dp.Sum || 0), 0);
        }
      } catch (error) {
        // Agent metrics might not exist
      }

      // Get Knowledge Base queries
      try {
        const kbCommand = new GetMetricStatisticsCommand({
          Namespace: 'AWS/Bedrock',
          MetricName: 'KnowledgeBaseQueries',
          StartTime: startTime,
          EndTime: endTime,
          Period: 3600,
          Statistics: ['Sum' as Statistic],
        });

        const kbResponse = await this.cloudwatchClient.send(kbCommand);
        if (kbResponse.Datapoints && kbResponse.Datapoints.length > 0) {
          knowledgeBaseQueries = kbResponse.Datapoints.reduce((sum, dp) => sum + (dp.Sum || 0), 0);
        }
      } catch (error) {
        // KB metrics might not exist
      }

      return { agentInvocations, knowledgeBaseQueries };
    } catch (error) {
      console.error('Error fetching agent metrics:', error);
      return { agentInvocations: 0, knowledgeBaseQueries: 0 };
    }
  }

  async getAgentTimeSeries(hours: number = 24): Promise<AgentTimeSeries> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);
    const period = hours <= 1 ? 300 : hours <= 12 ? 900 : hours <= 72 ? 3600 : 86400;

    const fetchAgentMetric = async (metricName: string, stat: string): Promise<TimeSeriesPoint[]> => {
      const allPoints = new Map<string, number>();
      const isExtended = stat.startsWith('p');
      for (const ns of ['AWS/Bedrock', 'AWS/BedrockAgent']) {
        try {
          const params: any = {
            Namespace: ns,
            MetricName: metricName,
            StartTime: startTime,
            EndTime: endTime,
            Period: period,
          };
          if (isExtended) {
            params.ExtendedStatistics = [stat];
          } else {
            params.Statistics = [stat as Statistic];
          }
          const response = await this.cloudwatchClient.send(new GetMetricStatisticsCommand(params));
          for (const dp of response.Datapoints || []) {
            const ts = dp.Timestamp?.toISOString() || '';
            let val = 0;
            if (isExtended && dp.ExtendedStatistics) {
              val = dp.ExtendedStatistics[stat] || 0;
            } else {
              val = (dp as any)[stat] || 0;
            }
            allPoints.set(ts, (allPoints.get(ts) || 0) + val);
          }
        } catch { }
      }
      return Array.from(allPoints.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([timestamp, value]) => ({ timestamp, value }));
    };

    const [agentInvocations, agentLatency, agentLatencyP50, agentLatencyP90, agentLatencyP99, agentErrors, agentStepCount, kbRetrieveCount, kbRetrieveLatency, kbErrors, guardrailInvocations, guardrailInterventions] = await Promise.all([
      fetchAgentMetric('Invocations', 'Sum'),
      fetchAgentMetric('Latency', 'Average'),
      fetchAgentMetric('Latency', 'p50'),
      fetchAgentMetric('Latency', 'p90'),
      fetchAgentMetric('Latency', 'p99'),
      fetchAgentMetric('InvocationErrors', 'Sum'),
      fetchAgentMetric('StepCount', 'Sum'),
      fetchAgentMetric('RetrieveCount', 'Sum'),
      fetchAgentMetric('RetrieveLatency', 'Average'),
      fetchAgentMetric('RetrieveErrors', 'Sum'),
      fetchAgentMetric('GuardrailInvocations', 'Sum'),
      fetchAgentMetric('GuardrailInterventions', 'Sum'),
    ]);

    return { agentInvocations, agentLatency, agentLatencyP50, agentLatencyP90, agentLatencyP99, agentErrors, agentStepCount, kbRetrieveCount, kbRetrieveLatency, kbErrors, guardrailInvocations, guardrailInterventions };
  }
}
