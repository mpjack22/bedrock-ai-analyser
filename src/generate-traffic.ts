import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const REGION = 'us-east-1';
const client = new BedrockRuntimeClient({ region: REGION });

const MODELS = [
  { id: 'us.anthropic.claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'us.amazon.nova-micro-v1:0', name: 'Nova Micro' },
];

const PROMPTS = [
  'What is cloud computing?',
  'Explain serverless architecture in one sentence.',
  'List 3 AWS services for machine learning.',
  'What is a VPC?',
  'Describe S3 in 10 words.',
  'What is IAM?',
  'Name 2 benefits of containers.',
  'What is a Lambda function?',
];

function randomPrompt(): string {
  return PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
}

async function invokeModel(modelId: string, prompt: string): Promise<boolean> {
  try {
    let body: string;
    if (modelId.includes('anthropic.')) {
      body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 50,
        messages: [{ role: 'user', content: prompt }],
      });
    } else if (modelId.includes('nova')) {
      body = JSON.stringify({
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 50, temperature: 0.7 },
      });
    } else if (modelId.includes('titan')) {
      body = JSON.stringify({
        inputText: prompt,
        textGenerationConfig: { maxTokenCount: 50, temperature: 0.7 },
      });
    } else {
      return false;
    }

    await client.send(new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    return true;
  } catch (error: any) {
    console.error(`  ✗ ${modelId}: ${error.message}`);
    return false;
  }
}

async function runBatch(batchNum: number, totalBatches: number) {
  console.log(`\n[Batch ${batchNum}/${totalBatches}] ${new Date().toLocaleTimeString()}`);

  for (const model of MODELS) {
    // Random number of requests per model (1-5)
    const count = 1 + Math.floor(Math.random() * 5);
    let success = 0;
    for (let i = 0; i < count; i++) {
      const ok = await invokeModel(model.id, randomPrompt());
      if (ok) success++;
      // Small delay between requests
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
    }
    console.log(`  ${model.name}: ${success}/${count} requests`);
  }
}

async function main() {
  const durationMinutes = parseInt(process.argv[2] || '30', 10);
  const intervalSeconds = parseInt(process.argv[3] || '60', 10);
  const totalBatches = Math.ceil((durationMinutes * 60) / intervalSeconds);

  console.log(`🔄 Generating Bedrock traffic`);
  console.log(`   Duration: ${durationMinutes} minutes`);
  console.log(`   Interval: ${intervalSeconds}s between batches`);
  console.log(`   Batches: ${totalBatches}`);
  console.log(`   Models: ${MODELS.map(m => m.name).join(', ')}`);
  console.log(`   Region: ${REGION}`);

  for (let i = 1; i <= totalBatches; i++) {
    await runBatch(i, totalBatches);
    if (i < totalBatches) {
      await new Promise(r => setTimeout(r, intervalSeconds * 1000));
    }
  }

  console.log('\n✅ Done! Metrics should appear in CloudWatch within 5-10 minutes.');
}

main().catch(console.error);
