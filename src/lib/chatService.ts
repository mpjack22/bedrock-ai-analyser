import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config.js';
import type { QuotaInfo, PredictionResult } from '../types/index.js';

export class ChatService {
  private bedrockClient: BedrockRuntimeClient;

  constructor() {
    this.bedrockClient = new BedrockRuntimeClient({ region: config.region });
  }

  async chat(
    userMessage: string,
    quotas: QuotaInfo[],
    predictions: PredictionResult[],
    agentMetrics: { agentInvocations: number; knowledgeBaseQueries: number }
  ): Promise<string> {
    const context = this.buildContext(quotas, predictions, agentMetrics);
    
    const prompt = `You are an expert AWS Bedrock AI usage analyser and capacity planning assistant embedded in a monitoring dashboard. You have access to real-time quota and usage data shown below.

Your capabilities:
1. USAGE ANALYSIS: Explain current usage patterns, identify which models are most/least used, and highlight anomalies.
2. LIMIT PREDICTIONS: Based on usage trends, predict when quotas might be exhausted. Calculate days remaining at current growth rates. Flag any model above 70% utilization as a concern.
3. QUOTA INCREASE GUIDANCE: When users want to increase limits, explain the process and tell them to use the "Request Quota Increase" form below the chat. Mention that only quotas marked "Adjustable" can be increased. Typical approval takes 1-3 business days.
4. RECOMMENDATIONS: Suggest which quotas to increase proactively, recommend usage optimizations (batching, caching, model selection), and advise on capacity planning.

Current Data (Region: ${config.region}):
${context}

IMPORTANT FORMATTING RULES:
- Be concise and specific with numbers
- Use plain text only (no markdown, no asterisks for bold)
- Use line breaks for readability
- When suggesting a quota increase, tell the user they can use the request form that appears below this chat

User Question: ${userMessage}`;

    try {
      const response = await this.bedrockClient.send(
        new InvokeModelCommand({
          modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 1000,
            messages: [
              {
                role: 'user',
                content: prompt,
              },
            ],
          }),
        })
      );

      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      return responseBody.content[0].text;
    } catch (error) {
      console.error('Error calling Bedrock:', error);
      return 'Sorry, I encountered an error processing your question. Please try again.';
    }
  }

  private buildContext(
    quotas: QuotaInfo[],
    predictions: PredictionResult[],
    agentMetrics: { agentInvocations: number; knowledgeBaseQueries: number }
  ): string {
    let context = 'QUOTAS:\n';
    quotas.slice(0, 20).forEach(q => {
      context += `- ${q.quotaName}: ${q.value} ${q.unit} (${q.adjustable ? 'Adjustable' : 'Fixed'})\n`;
    });

    context += '\nUSAGE & PREDICTIONS:\n';
    predictions.forEach(p => {
      context += `- ${p.modelId}:\n`;
      context += `  Current: ${p.currentUsage.toFixed(0)}, Limit: ${p.quotaLimit}\n`;
      context += `  Utilization: ${p.utilizationPercent.toFixed(1)}%\n`;
      if (p.predictedExhaustionDate) {
        context += `  Predicted Exhaustion: ${p.predictedExhaustionDate.toLocaleDateString()}\n`;
      }
      context += `  Status: ${p.recommendation}\n`;
    });

    context += '\nAGENT METRICS (24h):\n';
    context += `- Agent Invocations: ${agentMetrics.agentInvocations}\n`;
    context += `- Knowledge Base Queries: ${agentMetrics.knowledgeBaseQueries}\n`;

    return context;
  }
}
