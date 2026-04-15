import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { ServiceQuotasClient, RequestServiceQuotaIncreaseCommand } from '@aws-sdk/client-service-quotas';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, ListAccountAliasesCommand } from '@aws-sdk/client-iam';
import { QuotaService } from '../lib/quotaService.js';
import { PredictionService } from '../lib/predictionService.js';
import { ChatService } from '../lib/chatService.js';
import { UserStore } from '../lib/userStore.js';
import { config } from '../config.js';
import { OrganizationService } from '../lib/organizationService.js';
import { createQuotaServiceForAccount } from '../lib/v2QuotaFactory.js';

const PORT = process.env.PORT || 3000;
const LOGIN_USER = process.env.LOGIN_USERNAME || 'admin';
const LOGIN_PASS = process.env.LOGIN_PASSWORD || 'changeme';
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

const userStore = new UserStore(LOGIN_USER, LOGIN_PASS);

const sessions = new Map<string, { user: string; role: string; expires: number }>();

function createSession(user: string, role: string): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { user, role, expires: Date.now() + SESSION_TTL });
  return token;
}

function getSession(req: IncomingMessage): { user: string; role: string } | null {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([a-f0-9]{64})/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session || session.expires < Date.now()) {
    if (match[1]) sessions.delete(match[1]);
    return null;
  }
  return session;
}

function validateSession(req: IncomingMessage): boolean {
  return getSession(req) !== null;
}

function isAdmin(req: IncomingMessage): boolean {
  const session = getSession(req);
  return session?.role === 'admin';
}

function getSessionToken(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

function setSessionCookie(res: ServerResponse, token: string) {
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`);
}

function clearSessionCookie(res: ServerResponse) {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

const quotaService = new QuotaService();
const predictionService = new PredictionService();
const chatService = new ChatService();
const organizationService = new OrganizationService();

// Cache of per-region QuotaService instances
const regionServices = new Map<string, QuotaService>();
function getQuotaService(region: string): QuotaService {
  if (!regionServices.has(region)) {
    regionServices.set(region, new QuotaService(region));
  }
  return regionServices.get(region)!;
}

function getRegions(regionParam: string | null): string[] {
  if (!regionParam || regionParam === 'all') return config.bedrockRegions;
  return [regionParam];
}

/**
 * Returns a QuotaService for the given region and optional accountId.
 * When accountId is absent or matches the linked account, uses the existing getQuotaService.
 * When accountId is a different account, uses createQuotaServiceForAccount for cross-account access.
 */
async function getQuotaServiceForRequest(region: string, accountId?: string | null) {
  if (!accountId) {
    return getQuotaService(region);
  }
  const linkedId = await organizationService.getLinkedAccountId();
  if (accountId === linkedId) {
    return getQuotaService(region);
  }
  return createQuotaServiceForAccount(organizationService, region, accountId);
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

async function getModels(regions: string[], accountId?: string | null): Promise<string[]> {
  const all = new Set<string>();
  await Promise.all(regions.map(async (r) => {
    const svc = await getQuotaServiceForRequest(r, accountId);
    const models = await svc.listActiveModels();
    models.forEach(m => all.add(m));
  }));
  return all.size > 0 ? Array.from(all) : config.models;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  try {
    // --- Public routes: login page, login API, logout ---
    if (url.pathname === '/login' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(getLoginHTML());
      return;
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const { username, password } = JSON.parse(body);
      const auth = userStore.authenticate(username, password);
      if (auth.ok) {
        const token = createSession(username, auth.role);
        setSessionCookie(res, token);
        return json(res, 200, { ok: true, role: auth.role });
      }
      return json(res, 401, { error: 'Invalid credentials' });
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const token = getSessionToken(req);
      if (token) sessions.delete(token);
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    // --- Auth guard: everything below requires a valid session ---
    if (!validateSession(req)) {
      if (url.pathname.startsWith('/api/')) {
        return json(res, 401, { error: 'Unauthorized' });
      }
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }

    if (url.pathname === '/api/debug') {
      if (!isAdmin(req)) return json(res, 403, { error: 'Admin access required' });
      const region = url.searchParams.get('region') || config.region;
      const modelId = url.searchParams.get('modelId') || config.models[0];
      const hours = parseInt(url.searchParams.get('hours') || '1', 10);
      const accountId = url.searchParams.get('accountId');

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);
      const period = hours <= 1 ? 300 : hours <= 12 ? 900 : 3600;

      const svc = await getQuotaServiceForRequest(region, accountId);
      const results: Record<string, any> = {
        query: { region, modelId, hours, period, startTime: startTime.toISOString(), endTime: endTime.toISOString(), accountId: accountId || 'linked account' },
        namespaces: {},
      };

      for (const ns of ['AWS/Bedrock', 'AWS/BedrockRuntime']) {
        results.namespaces[ns] = {};
        for (const metric of ['Invocations', 'InputTokenCount', 'OutputTokenCount', 'InvocationLatency', 'InvocationClientErrors', 'InvocationServerErrors', 'InvocationThrottles']) {
          try {
            const { CloudWatchClient, GetMetricStatisticsCommand } = await import('@aws-sdk/client-cloudwatch');
            const cw = new (CloudWatchClient as any)({ region });
            const resp = await cw.send(new (GetMetricStatisticsCommand as any)({
              Namespace: ns,
              MetricName: metric,
              Dimensions: [{ Name: 'ModelId', Value: modelId }],
              StartTime: startTime,
              EndTime: endTime,
              Period: period,
              Statistics: ['Sum', 'Average', 'Maximum'],
            }));
            const datapoints = (resp.Datapoints || []).sort((a: any, b: any) => new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime());
            results.namespaces[ns][metric] = {
              datapointCount: datapoints.length,
              totalSum: datapoints.reduce((s: number, d: any) => s + (d.Sum || 0), 0),
              datapoints: datapoints.map((d: any) => ({
                timestamp: d.Timestamp,
                sum: d.Sum,
                average: d.Average,
                maximum: d.Maximum,
              })),
            };
          } catch (err: any) {
            results.namespaces[ns][metric] = { error: err.message };
          }
        }
      }

      // Also show processed values from the service
      try {
        const processed = await svc.getModelTimeSeries(modelId, hours);
        results.processed = {
          invocationsTotal: processed.invocations.reduce((s, p) => s + p.value, 0),
          inputTokensTotal: processed.inputTokens.reduce((s, p) => s + p.value, 0),
          outputTokensTotal: processed.outputTokens.reduce((s, p) => s + p.value, 0),
          latencyAvg: processed.latency.length ? (processed.latency.reduce((s, p) => s + p.value, 0) / processed.latency.length).toFixed(0) + 'ms' : 'no data',
          throttlesTotal: processed.throttles.reduce((s, p) => s + p.value, 0),
          datapoints: processed.invocations.length,
        };
      } catch (err: any) {
        results.processed = { error: err.message };
      }

      return json(res, 200, results);
    }

    if (url.pathname === '/api/demo-data') {
      const hours = parseInt(url.searchParams.get('hours') || '24', 10);
      const now = Date.now();
      const period = hours <= 1 ? 300 : hours <= 12 ? 900 : hours <= 72 ? 3600 : 86400;
      const points = Math.floor((hours * 3600) / period);
      const models = ['us.anthropic.claude-sonnet-4-6', 'us.amazon.nova-micro-v1:0'];

      // Quota limits (per minute)
      const RPM_LIMIT = 1000;
      const TPM_LIMIT = 500000;

      const wave = (i: number, amp: number, offset = 0) =>
        Math.max(0, Math.round(amp * (0.5 + 0.4 * Math.sin((i / points) * Math.PI * 4 + offset)) + amp * 0.1 * Math.random()));

      // Spike function: normal usage with periodic bursts that exceed the limit
      const spike = (i: number, base: number, limit: number, spikeEvery = 7, spikeMult = 1.4) => {
        const normal = wave(i, base * 0.7);
        const isSpiking = Math.floor(i / spikeEvery) % 3 === 0 && i % spikeEvery < 2;
        return isSpiking ? Math.round(limit * spikeMult * (1 + 0.2 * Math.random())) : normal;
      };

      const periodMinutes = period / 60;

      const makeSeries = (modelIdx: number) => {
        const amp = modelIdx === 0 ? 800 : 300;
        const rpmBase = modelIdx === 0 ? RPM_LIMIT * periodMinutes * 0.65 : RPM_LIMIT * periodMinutes * 0.25;
        const tpmBase = modelIdx === 0 ? TPM_LIMIT * periodMinutes * 0.6 : TPM_LIMIT * periodMinutes * 0.2;
        const ts = Array.from({ length: points }, (_, i) => ({
          timestamp: new Date(now - (points - i) * period * 1000).toISOString(),
          i,
        }));
        return {
          modelId: models[modelIdx],
          // Invocations spike above RPM_LIMIT * periodMinutes periodically
          invocations: ts.map(({ timestamp, i }) => ({ timestamp, value: spike(i, rpmBase, RPM_LIMIT * periodMinutes, 6 + modelIdx, 1.35) })),
          // Input tokens spike above TPM_LIMIT * periodMinutes periodically
          inputTokens: ts.map(({ timestamp, i }) => ({ timestamp, value: spike(i, tpmBase * 0.7, TPM_LIMIT * periodMinutes * 0.7, 8 + modelIdx, 1.4) })),
          outputTokens: ts.map(({ timestamp, i }) => ({ timestamp, value: spike(i, tpmBase * 0.3, TPM_LIMIT * periodMinutes * 0.3, 8 + modelIdx, 1.4) })),
          latency: ts.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 800, modelIdx) + 400 })),
          latencyP50: ts.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 600, modelIdx) + 300 })),
          latencyP90: ts.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 1200, modelIdx) + 600 })),
          latencyP99: ts.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 2000, modelIdx) + 1000 })),
          clientErrors: ts.map(({ timestamp, i }) => ({ timestamp, value: i % 8 === 0 ? Math.round(Math.random() * 3) : 0 })),
          serverErrors: ts.map(({ timestamp, i }) => ({ timestamp, value: i % 20 === 0 ? 1 : 0 })),
          // Throttles appear when spiking
          throttles: ts.map(({ timestamp, i }) => {
            const isSpiking = Math.floor(i / (6 + modelIdx)) % 3 === 0 && i % (6 + modelIdx) < 2;
            return { timestamp, value: isSpiking ? Math.round(5 + Math.random() * 15) : 0 };
          }),
        };
      };

      const agentTs = Array.from({ length: points }, (_, i) => ({
        timestamp: new Date(now - (points - i) * period * 1000).toISOString(), i,
      }));

      return json(res, 200, {
        series: [makeSeries(0), makeSeries(1)],
        agentSeries: {
          agentInvocations: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 50) })),
          agentLatency: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 3000) + 2000 })),
          agentLatencyP50: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 2000) + 1500 })),
          agentLatencyP90: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 4000) + 3000 })),
          agentLatencyP99: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 6000) + 5000 })),
          agentErrors: agentTs.map(({ timestamp, i }) => ({ timestamp, value: i % 15 === 0 ? 1 : 0 })),
          agentStepCount: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 200) + 50 })),
          kbRetrieveCount: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 150) + 30 })),
          kbRetrieveLatency: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 400) + 200 })),
          kbErrors: agentTs.map(({ timestamp, i }) => ({ timestamp, value: i % 25 === 0 ? 1 : 0 })),
          guardrailInvocations: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 80) + 10 })),
          guardrailInterventions: agentTs.map(({ timestamp, i }) => ({ timestamp, value: wave(i, 15) })),
        },
        usage: models.map((m, idx) => ({ modelId: m, invocations: 1200 - idx * 400, period: hours + 'h' })),
        quotas: [
          { quotaName: '[bedrock] Requests per minute', quotaCode: 'L-1234', value: RPM_LIMIT, unit: 'None', adjustable: true },
          { quotaName: '[bedrock] Input tokens per minute', quotaCode: 'L-5678', value: TPM_LIMIT, unit: 'None', adjustable: true },
          { quotaName: '[bedrock] Output tokens per minute', quotaCode: 'L-9012', value: Math.round(TPM_LIMIT * 0.4), unit: 'None', adjustable: true },
        ],
        agentMetrics: { agentInvocations: 342, knowledgeBaseQueries: 891 },
        activeModels: models,
        accountId: 'DEMO-MODE',
        accountName: 'Demo Account',
      });
    }

    if (url.pathname === '/api/account') {
      try {
        const sts = new STSClient({ region: 'us-east-1' });
        const identity = await sts.send(new GetCallerIdentityCommand({}));
        let accountName = '';
        try {
          const iam = new IAMClient({ region: 'us-east-1' });
          const aliases = await iam.send(new ListAccountAliasesCommand({}));
          accountName = aliases.AccountAliases?.[0] || '';
        } catch { }
        return json(res, 200, { accountId: identity.Account, accountName, arn: identity.Arn });
      } catch (error: any) {
        return json(res, 200, { accountId: 'Unknown', accountName: '', arn: '' });
      }
    }

    if (url.pathname === '/api/v2/accounts') {
      try {
        const accounts = await organizationService.listAccounts();
        const linkedAccountId = await organizationService.getLinkedAccountId();
        return json(res, 200, { accounts, linkedAccountId });
      } catch (error: any) {
        console.error('Error fetching organization accounts:', error);
        return json(res, 200, { accounts: [], linkedAccountId: '' });
      }
    }

    if (url.pathname === '/api/quotas') {
      const accountId = url.searchParams.get('accountId');
      try {
        const regions = getRegions(url.searchParams.get('region'));
        const allQuotas = await Promise.all(regions.map(async (r) => {
          const svc = await getQuotaServiceForRequest(r, accountId);
          return svc.getBedrockQuotas();
        }));
        const quotas = allQuotas.flat();
        return json(res, 200, { quotas });
      } catch (error: any) {
        if (error.message?.includes('BedrockAnalyserReadRole')) {
          return json(res, 403, { error: error.message });
        }
        throw error;
      }
    }

    if (url.pathname === '/api/usage') {
      const accountId = url.searchParams.get('accountId');
      try {
        const regions = getRegions(url.searchParams.get('region'));
        const hours = parseInt(url.searchParams.get('hours') || '24', 10);
        const models = await getModels(regions, accountId);
        const usage = [];
        for (const modelId of models) {
          let total = 0;
          await Promise.all(regions.map(async (r) => {
            const svc = await getQuotaServiceForRequest(r, accountId);
            total += await svc.getModelInvocationMetrics(modelId, hours);
          }));
          if (total > 0) usage.push({ modelId, invocations: total, period: hours + 'h' });
        }
        return json(res, 200, { usage });
      } catch (error: any) {
        if (error.message?.includes('BedrockAnalyserReadRole')) {
          return json(res, 403, { error: error.message });
        }
        throw error;
      }
    }

    if (url.pathname === '/api/agents') {
      const accountId = url.searchParams.get('accountId');
      try {
        const regions = getRegions(url.searchParams.get('region'));
        let agentInvocations = 0, knowledgeBaseQueries = 0;
        await Promise.all(regions.map(async (r) => {
          const svc = await getQuotaServiceForRequest(r, accountId);
          const m = await svc.getAgentMetrics(24);
          agentInvocations += m.agentInvocations;
          knowledgeBaseQueries += m.knowledgeBaseQueries;
        }));
        return json(res, 200, { agentMetrics: { agentInvocations, knowledgeBaseQueries } });
      } catch (error: any) {
        if (error.message?.includes('BedrockAnalyserReadRole')) {
          return json(res, 403, { error: error.message });
        }
        throw error;
      }
    }

    if (url.pathname === '/api/timeseries') {
      const accountId = url.searchParams.get('accountId');
      try {
        const hours = parseInt(url.searchParams.get('hours') || '24', 10);
        const regions = getRegions(url.searchParams.get('region'));
        const models = await getModels(regions, accountId);
        type MetricAgg = { sums: Map<string, number>; avgs: Map<string, number[]> };
        const newSums = () => new Map<string, number>();
        const newAvgs = () => new Map<string, number[]>();
        const seriesMap = new Map<string, { invocations: Map<string, number>; inputTokens: Map<string, number>; outputTokens: Map<string, number>; latency: Map<string, number[]>; latencyP50: Map<string, number[]>; latencyP90: Map<string, number[]>; latencyP99: Map<string, number[]>; clientErrors: Map<string, number>; serverErrors: Map<string, number>; throttles: Map<string, number> }>();
        for (const modelId of models) {
          seriesMap.set(modelId, { invocations: newSums(), inputTokens: newSums(), outputTokens: newSums(), latency: newAvgs(), latencyP50: newAvgs(), latencyP90: newAvgs(), latencyP99: newAvgs(), clientErrors: newSums(), serverErrors: newSums(), throttles: newSums() });
        }
        const addSum = (m: Map<string, number>, ts: string, v: number) => m.set(ts, (m.get(ts) || 0) + v);
        const addAvg = (m: Map<string, number[]>, ts: string, v: number) => { if (!m.has(ts)) m.set(ts, []); m.get(ts)!.push(v); };
        await Promise.all(regions.map(async (r) => {
          const svc = await getQuotaServiceForRequest(r, accountId);
          await Promise.all(models.map(async (modelId) => {
            const ts = await svc.getModelTimeSeries(modelId, hours);
            const e = seriesMap.get(modelId)!;
            for (const p of ts.invocations) addSum(e.invocations, p.timestamp, p.value);
            for (const p of ts.inputTokens) addSum(e.inputTokens, p.timestamp, p.value);
            for (const p of ts.outputTokens) addSum(e.outputTokens, p.timestamp, p.value);
            for (const p of ts.latency) addAvg(e.latency, p.timestamp, p.value);
            for (const p of ts.latencyP50) addAvg(e.latencyP50, p.timestamp, p.value);
            for (const p of ts.latencyP90) addAvg(e.latencyP90, p.timestamp, p.value);
            for (const p of ts.latencyP99) addAvg(e.latencyP99, p.timestamp, p.value);
            for (const p of ts.clientErrors) addSum(e.clientErrors, p.timestamp, p.value);
            for (const p of ts.serverErrors) addSum(e.serverErrors, p.timestamp, p.value);
            for (const p of ts.throttles) addSum(e.throttles, p.timestamp, p.value);
          }));
        }));
        const series = models.map(modelId => {
          const e = seriesMap.get(modelId)!;
          const toArr = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([timestamp, value]) => ({ timestamp, value }));
          const toAvgArr = (m: Map<string, number[]>) => Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([timestamp, vals]) => ({ timestamp, value: vals.reduce((a, b) => a + b, 0) / vals.length }));
          return { modelId, invocations: toArr(e.invocations), inputTokens: toArr(e.inputTokens), outputTokens: toArr(e.outputTokens), latency: toAvgArr(e.latency), latencyP50: toAvgArr(e.latencyP50), latencyP90: toAvgArr(e.latencyP90), latencyP99: toAvgArr(e.latencyP99), clientErrors: toArr(e.clientErrors), serverErrors: toArr(e.serverErrors), throttles: toArr(e.throttles) };
        });
        return json(res, 200, { series, hours });
      } catch (error: any) {
        if (error.message?.includes('BedrockAnalyserReadRole')) {
          return json(res, 403, { error: error.message });
        }
        throw error;
      }
    }

    if (url.pathname === '/api/agent-timeseries') {
      const accountId = url.searchParams.get('accountId');
      try {
        const hours = parseInt(url.searchParams.get('hours') || '24', 10);
        const regions = getRegions(url.searchParams.get('region'));
        const keys = ['agentInvocations','agentLatency','agentLatencyP50','agentLatencyP90','agentLatencyP99','agentErrors','agentStepCount','kbRetrieveCount','kbRetrieveLatency','kbErrors','guardrailInvocations','guardrailInterventions'] as const;
        const sums = new Map<string, Map<string, number>>();
        const avgs = new Map<string, Map<string, number[]>>();
        const avgKeys = new Set(['agentLatency','agentLatencyP50','agentLatencyP90','agentLatencyP99','kbRetrieveLatency']);
        for (const k of keys) { if (avgKeys.has(k)) avgs.set(k, new Map()); else sums.set(k, new Map()); }
        await Promise.all(regions.map(async (r) => {
          const svc = await getQuotaServiceForRequest(r, accountId);
          const ts = await svc.getAgentTimeSeries(hours);
          for (const k of keys) {
            const points = ts[k] as { timestamp: string; value: number }[];
            if (avgKeys.has(k)) { const m = avgs.get(k)!; for (const p of points) { if (!m.has(p.timestamp)) m.set(p.timestamp, []); m.get(p.timestamp)!.push(p.value); } }
            else { const m = sums.get(k)!; for (const p of points) m.set(p.timestamp, (m.get(p.timestamp) || 0) + p.value); }
          }
        }));
        const toArr = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([t, v]) => ({ timestamp: t, value: v }));
        const toAvg = (m: Map<string, number[]>) => Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([t, vs]) => ({ timestamp: t, value: vs.reduce((a, b) => a + b, 0) / vs.length }));
        const result: any = {};
        for (const k of keys) { result[k] = avgKeys.has(k) ? toAvg(avgs.get(k)!) : toArr(sums.get(k)!); }
        return json(res, 200, result);
      } catch (error: any) {
        if (error.message?.includes('BedrockAnalyserReadRole')) return json(res, 403, { error: error.message });
        throw error;
      }
    }

    if (url.pathname === '/api/active-models') {
      const accountId = url.searchParams.get('accountId');
      try {
        const regions = getRegions(url.searchParams.get('region'));
        const allModels = new Set<string>();
        await Promise.all(regions.map(async (r) => {
          const svc = await getQuotaServiceForRequest(r, accountId);
          const models = await svc.listActiveModels();
          models.forEach(m => allModels.add(m));
        }));
        const models = allModels.size > 0 ? Array.from(allModels) : config.models;
        return json(res, 200, { models });
      } catch (error: any) {
        if (error.message?.includes('BedrockAnalyserReadRole')) {
          return json(res, 403, { error: error.message });
        }
        throw error;
      }
    }

    if (url.pathname === '/api/predictions') {
      const accountId = url.searchParams.get('accountId');
      try {
        const regions = getRegions(url.searchParams.get('region'));
        const allQuotas = await Promise.all(regions.map(async (r) => {
          const svc = await getQuotaServiceForRequest(r, accountId);
          return svc.getBedrockQuotas();
        }));
        const quotas = allQuotas.flat();
        const invocationQuota = quotas.find(q => q.quotaName.toLowerCase().includes('invocation'));
        const models = await getModels(regions, accountId);
        const predictions = [];
        for (const modelId of models) {
          let totalInvocations = 0;
          await Promise.all(regions.map(async (r) => {
            const svc = await getQuotaServiceForRequest(r, accountId);
            totalInvocations += await svc.getModelInvocationMetrics(modelId, 168);
          }));
          for (let i = 0; i < 7; i++) {
            predictionService.addUsageData(modelId, {
              timestamp: new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000),
              modelId,
              invocations: totalInvocations * (0.7 + i * 0.05),
              inputTokens: 0,
              outputTokens: 0,
            });
          }
          predictions.push(predictionService.predictExhaustion(modelId, invocationQuota?.value || 1000000));
        }
        return json(res, 200, { predictions });
      } catch (error: any) {
        if (error.message?.includes('BedrockAnalyserReadRole')) {
          return json(res, 403, { error: error.message });
        }
        throw error;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await parseBody(req);
      const { message, region: chatRegion } = JSON.parse(body);
      const regions = getRegions(chatRegion || null);
      const allQuotas = await Promise.all(regions.map(r => getQuotaService(r).getBedrockQuotas()));
      const quotas = allQuotas.flat();
      let agentInvocations = 0, knowledgeBaseQueries = 0;
      await Promise.all(regions.map(async (r) => {
        const m = await getQuotaService(r).getAgentMetrics(24);
        agentInvocations += m.agentInvocations;
        knowledgeBaseQueries += m.knowledgeBaseQueries;
      }));
      const agentMetrics = { agentInvocations, knowledgeBaseQueries };
      const invocationQuota = quotas.find(q => q.quotaName.toLowerCase().includes('invocation'));
      const models = await getModels(regions);
      const predictions = [];
      for (const modelId of models) {
        let totalInvocations = 0;
        await Promise.all(regions.map(async (r) => {
          totalInvocations += await getQuotaService(r).getModelInvocationMetrics(modelId, 168);
        }));
        for (let i = 0; i < 7; i++) {
          predictionService.addUsageData(modelId, {
            timestamp: new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000),
            modelId,
            invocations: totalInvocations * (0.7 + i * 0.05),
            inputTokens: 0,
            outputTokens: 0,
          });
        }
        predictions.push(predictionService.predictExhaustion(modelId, invocationQuota?.value || 1000000));
      }
      const response = await chatService.chat(message, quotas, predictions, agentMetrics);
      return json(res, 200, { response });
    }

    if (req.method === 'POST' && url.pathname === '/api/request-increase') {
      const body = await parseBody(req);
      const { serviceCode, quotaCode, desiredValue, region } = JSON.parse(body);
      try {
        const regionClient = new ServiceQuotasClient({ region: region || config.region });
        const result = await regionClient.send(
          new RequestServiceQuotaIncreaseCommand({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
            DesiredValue: desiredValue,
          })
        );
        return json(res, 200, {
          requestId: result.RequestedQuota?.Id || 'submitted',
          status: result.RequestedQuota?.Status,
          quotaName: result.RequestedQuota?.QuotaName,
        });
      } catch (error: any) {
        console.error('Quota increase request error:', error);
        return json(res, 400, { error: error.message || 'Failed to submit quota increase request' });
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const session = getSession(req);
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(getHTML(session?.user || '', session?.role || 'viewer'));
      return;
    }

    // --- Admin routes ---
    if (url.pathname === '/admin') {
      if (!isAdmin(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
      const session = getSession(req);
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(getAdminHTML(session?.user || ''));
      return;
    }

    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      if (!isAdmin(req)) return json(res, 403, { error: 'Admin access required' });
      const users = userStore.listUsers();
      return json(res, 200, { users, adminUser: LOGIN_USER });
    }

    if (url.pathname === '/api/admin/users' && req.method === 'POST') {
      if (!isAdmin(req)) return json(res, 403, { error: 'Admin access required' });
      const body = await parseBody(req);
      const { username, password, role } = JSON.parse(body);
      const session = getSession(req);
      const result = userStore.createUser(username, password, role || 'viewer', session?.user || 'admin');
      return json(res, result.ok ? 200 : 400, result);
    }

    if (url.pathname === '/api/admin/users' && req.method === 'DELETE') {
      if (!isAdmin(req)) return json(res, 403, { error: 'Admin access required' });
      const body = await parseBody(req);
      const { username } = JSON.parse(body);
      const result = userStore.deleteUser(username);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (url.pathname === '/api/admin/reset-password' && req.method === 'POST') {
      if (!isAdmin(req)) return json(res, 403, { error: 'Admin access required' });
      const body = await parseBody(req);
      const { username, newPassword } = JSON.parse(body);
      const result = userStore.resetPassword(username, newPassword);
      return json(res, result.ok ? 200 : 400, result);
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Request error:', error);
    json(res, 500, { error: 'Internal server error' });
  }
}

function getLoginHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Bedrock AI Analyser</title>
  <style>
    :root { --bg: #0f172a; --surface: #1e293b; --border: #475569; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; --red: #ef4444; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 40px; width: 100%; max-width: 400px; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
    .login-card h1 { font-size: 22px; margin-bottom: 6px; text-align: center; }
    .login-card h1 span { color: var(--accent); }
    .login-card p { color: var(--muted); font-size: 13px; text-align: center; margin-bottom: 28px; }
    .field { margin-bottom: 18px; }
    .field label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; font-weight: 500; }
    .field input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; transition: border-color .2s; }
    .field input:focus { border-color: var(--accent); }
    .btn { width: 100%; background: var(--accent); color: #fff; border: none; padding: 12px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity .2s; }
    .btn:hover { opacity: .85; }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .error { color: var(--red); font-size: 13px; text-align: center; margin-top: 14px; min-height: 20px; }
  </style>
</head>
<body>
  <div class="login-card">
    <h1>📊 <span>Bedrock</span> AI Analyser</h1>
    <p>Sign in to access the dashboard</p>
    <form id="loginForm" onsubmit="return doLogin(event)">
      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" required autofocus />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
      </div>
      <button class="btn" type="submit" id="loginBtn">Sign In</button>
      <div class="error" id="loginError"></div>
    </form>
  </div>
  <script>
    async function doLogin(e) {
      e.preventDefault();
      const btn = document.getElementById('loginBtn');
      const err = document.getElementById('loginError');
      btn.disabled = true; btn.textContent = 'Signing in...'; err.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        if (res.ok) { window.location.href = '/'; return false; }
        const data = await res.json();
        err.textContent = data.error || 'Login failed';
      } catch { err.textContent = 'Connection error'; }
      btn.disabled = false; btn.textContent = 'Sign In';
      return false;
    }
  </script>
</body>
</html>`;
}

function getAdminHTML(username: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Bedrock AI Analyser</title>
  <style>
    :root { --bg: #0f172a; --surface: #1e293b; --surface2: #334155; --border: #475569; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; --green: #22c55e; --red: #ef4444; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    .container { max-width: 800px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    header h1 { font-size: 22px; }
    header h1 span { color: var(--accent); }
    .btn { background: var(--accent); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: opacity .2s; text-decoration: none; display: inline-block; }
    .btn:hover { opacity: .85; }
    .btn-danger { background: var(--red); }
    .btn-sm { padding: 5px 12px; font-size: 12px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .card-title { font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 16px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 10px; align-items: end; }
    .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    .field input, .field select { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font-size: 13px; outline: none; }
    .field input:focus, .field select:focus { border-color: var(--accent); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: var(--muted); font-weight: 500; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    td { padding: 10px 12px; border-bottom: 1px solid var(--surface2); }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 99px; font-size: 11px; font-weight: 700; }
    .badge-admin { background: rgba(139,92,246,.15); color: #a78bfa; }
    .badge-viewer { background: rgba(59,130,246,.15); color: #60a5fa; }
    .msg { font-size: 13px; margin-top: 10px; min-height: 20px; }
    .msg-ok { color: var(--green); }
    .msg-err { color: var(--red); }
    .actions { display: flex; gap: 6px; }
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>⚙ <span>User</span> Management</h1>
    <div style="display:flex;gap:10px;align-items:center">
      <span style="color:var(--muted);font-size:13px">👤 ${username}</span>
      <a href="/" class="btn" style="background:var(--surface2)">← Dashboard</a>
    </div>
  </header>

  <div class="card">
    <div class="card-title">Create User</div>
    <div class="form-row">
      <div class="field"><label>Username</label><input id="newUser" placeholder="username" /></div>
      <div class="field"><label>Password</label><input id="newPass" type="password" placeholder="password" /></div>
      <div class="field"><label>Role</label><select id="newRole"><option value="viewer">Viewer</option><option value="admin">Admin</option></select></div>
      <button class="btn" onclick="createUser()" style="margin-bottom:1px">Create</button>
    </div>
    <div class="msg" id="createMsg"></div>
  </div>

  <div class="card">
    <div class="card-title">Users</div>
    <table>
      <thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Created By</th><th></th></tr></thead>
      <tbody id="userTable"><tr><td colspan="5" style="color:var(--muted)">Loading...</td></tr></tbody>
    </table>
  </div>

  <div class="card" id="resetCard" style="display:none">
    <div class="card-title">Reset Password</div>
    <div style="display:flex;gap:10px;align-items:end">
      <div class="field" style="flex:1"><label>User: <span id="resetUser" style="color:var(--text)"></span></label><input id="resetPass" type="password" placeholder="New password" /></div>
      <button class="btn" onclick="resetPassword()">Reset</button>
      <button class="btn" style="background:var(--surface2)" onclick="hideReset()">Cancel</button>
    </div>
    <div class="msg" id="resetMsg"></div>
  </div>
</div>
<script>
var resetTarget = '';

async function loadUsers() {
  var res = await fetch('/api/admin/users');
  var data = await res.json();
  var tbody = document.getElementById('userTable');
  var rows = '<tr><td style="color:var(--accent)">' + data.adminUser + '</td><td><span class="badge badge-admin">admin</span></td><td style="color:var(--muted)">—</td><td style="color:var(--muted)">env</td><td style="color:var(--muted);font-size:12px">Primary admin</td></tr>';
  data.users.forEach(function(u) {
    var badge = u.role === 'admin' ? 'badge-admin' : 'badge-viewer';
    var created = new Date(u.createdAt).toLocaleDateString();
    rows += '<tr><td>' + u.username + '</td><td><span class="badge ' + badge + '">' + u.role + '</span></td><td style="color:var(--muted)">' + created + '</td><td style="color:var(--muted)">' + u.createdBy + '</td><td><div class="actions"><button class="btn btn-sm" style="background:var(--surface2)" onclick="showReset(\\'' + u.username + '\\')">Reset PW</button><button class="btn btn-sm btn-danger" onclick="deleteUser(\\'' + u.username + '\\')">Delete</button></div></td></tr>';
  });
  tbody.innerHTML = rows;
}

async function createUser() {
  var msg = document.getElementById('createMsg');
  var username = document.getElementById('newUser').value.trim();
  var password = document.getElementById('newPass').value;
  var role = document.getElementById('newRole').value;
  if (!username || !password) { msg.className = 'msg msg-err'; msg.textContent = 'Fill in all fields'; return; }
  var res = await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, password: password, role: role }) });
  var data = await res.json();
  if (data.ok) {
    msg.className = 'msg msg-ok'; msg.textContent = 'User created';
    document.getElementById('newUser').value = '';
    document.getElementById('newPass').value = '';
    loadUsers();
  } else { msg.className = 'msg msg-err'; msg.textContent = data.error || 'Failed'; }
}

async function deleteUser(username) {
  if (!confirm('Delete user ' + username + '?')) return;
  var res = await fetch('/api/admin/users', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username }) });
  var data = await res.json();
  if (data.ok) loadUsers();
  else alert(data.error || 'Failed');
}

function showReset(username) {
  resetTarget = username;
  document.getElementById('resetUser').textContent = username;
  document.getElementById('resetPass').value = '';
  document.getElementById('resetMsg').textContent = '';
  document.getElementById('resetCard').style.display = 'block';
}

function hideReset() {
  document.getElementById('resetCard').style.display = 'none';
}

async function resetPassword() {
  var msg = document.getElementById('resetMsg');
  var pw = document.getElementById('resetPass').value;
  if (!pw) { msg.className = 'msg msg-err'; msg.textContent = 'Enter a password'; return; }
  var res = await fetch('/api/admin/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: resetTarget, newPassword: pw }) });
  var data = await res.json();
  if (data.ok) { msg.className = 'msg msg-ok'; msg.textContent = 'Password reset'; }
  else { msg.className = 'msg msg-err'; msg.textContent = data.error || 'Failed'; }
}

loadUsers();
</script>
</body>
</html>`;
}

function getHTML(username: string, role: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bedrock AI Analyser</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.1.0/dist/chartjs-plugin-annotation.min.js"></script>
  <style>
    :root {
      --bg: #0f172a; --surface: #1e293b; --surface2: #334155;
      --border: #475569; --text: #e2e8f0; --muted: #94a3b8;
      --accent: #3b82f6; --accent2: #8b5cf6; --green: #22c55e;
      --yellow: #eab308; --red: #ef4444; --orange: #f97316;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 16px; }
    header h1 { font-size: 24px; font-weight: 700; }
    header h1 span { color: var(--accent); }
    .controls { display: flex; align-items: center; gap: 12px; }
    .btn { background: var(--accent); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: opacity .2s; }
    .btn:hover { opacity: .85; }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--muted); }
    .btn-outline.active { border-color: var(--accent); color: var(--accent); }
    select { background: var(--surface); color: var(--text); border: 1px solid var(--border); padding: 8px 12px; border-radius: 8px; font-size: 13px; }
    .acct-selector { position: relative; }
    .acct-selector input { background: var(--surface); color: var(--text); border: 1px solid var(--border); padding: 8px 12px; border-radius: 8px; font-size: 13px; width: 220px; outline: none; }
    .acct-selector input:focus { border-color: var(--accent); }
    .acct-dropdown { display: none; position: absolute; top: 100%; left: 0; margin-top: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 4px 0; z-index: 200; min-width: 280px; max-height: 240px; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    .acct-dropdown.open { display: block; }
    .acct-dropdown-item { padding: 8px 12px; font-size: 13px; cursor: pointer; color: var(--text); }
    .acct-dropdown-item:hover { background: var(--surface2); }
    .acct-dropdown-item.selected { color: var(--accent); }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 99px; font-size: 11px; font-weight: 700; }
    .badge-ok { background: rgba(34,197,94,.15); color: var(--green); }
    .badge-warn { background: rgba(234,179,8,.15); color: var(--yellow); }
    .badge-crit { background: rgba(239,68,68,.15); color: var(--red); }
    .timestamp { color: var(--muted); font-size: 12px; }
    .grid { display: grid; gap: 20px; margin-bottom: 20px; }
    .grid-4 { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
    .grid-2 { grid-template-columns: repeat(auto-fit, minmax(500px, 1fr)); }
    .grid-1 { grid-template-columns: 1fr; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .card-title { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
    .chart-desc { font-size: 11px; color: #64748b; margin-bottom: 12px; line-height: 1.4; }
    .stat-value { font-size: 28px; font-weight: 700; }
    .stat-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .chart-wrap { position: relative; height: 300px; }
    .quota-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--surface2); }
    .quota-row:last-child { border-bottom: none; }
    .quota-name { font-size: 13px; font-weight: 500; flex: 1; }
    .quota-val { font-size: 13px; color: var(--muted); text-align: right; min-width: 120px; }
    .bar-track { height: 6px; background: var(--surface2); border-radius: 3px; margin-top: 6px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 3px; transition: width .4s ease; }
    .prediction-card { background: var(--surface2); border-radius: 8px; padding: 16px; margin-bottom: 12px; border-left: 3px solid var(--accent); }
    .prediction-card.warn { border-left-color: var(--yellow); }
    .prediction-card.crit { border-left-color: var(--red); }
    .pred-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .pred-model { font-weight: 600; font-size: 14px; }
    .pred-row { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); margin: 4px 0; }
    .pred-row span:last-child { color: var(--text); font-weight: 500; }
    .pred-rec { font-size: 12px; color: var(--muted); margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
    .loading { color: var(--muted); font-size: 13px; padding: 20px; text-align: center; }
    .msg { margin-bottom: 0; }
    .msg.user { text-align: right; }
    .msg .bubble { display: inline-block; max-width: 85%; padding: 10px 14px; border-radius: 10px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
    .msg.user .bubble { background: var(--accent); color: #fff; }
    .msg.bot .bubble { background: var(--surface2); color: var(--text); }
    .msg .bubble em { color: var(--accent); font-style: normal; cursor: pointer; }
    .msg .bubble em:hover { text-decoration: underline; }
    .hidden { display: none !important; }
    @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } .chat-box { width: calc(100vw - 48px); } }
  </style>
</head>
<body>
<div class="container">
  <header style="flex-direction:column;align-items:stretch">
    <div style="text-align:center;margin-bottom:16px">
      <h1 style="font-size:30px">📊 <span>Bedrock</span> AI Analyser</h1>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="color:var(--muted);font-size:12px;background:var(--surface2);padding:4px 10px;border-radius:6px" id="accountBadge">Account: ...</span>
        <div class="acct-selector">
          <input id="acctSearch" type="text" placeholder="Current Account" onfocus="openAcctDropdown()" oninput="filterAccounts(this.value)" autocomplete="off" />
          <div id="acctDropdown" class="acct-dropdown"></div>
        </div>
        <span style="color:var(--muted);font-size:13px">Region</span>
        <select id="regionSelect" onchange="setRegion(this.value)" style="background:var(--surface);color:var(--text);border:1px solid var(--border);padding:8px 12px;border-radius:8px;font-size:13px">
          ${config.bedrockRegions.map(r => `<option value="${r}"${r === 'us-east-1' ? ' selected' : ''}>${r}</option>`).join('\n          ')}
        </select>
        <div style="position:relative">
          <button class="btn-outline" id="modelFilterBtn" onclick="toggleModelDropdown()" style="min-width:140px;text-align:left">All Models ▾</button>
          <div id="modelDropdown" class="hidden" style="position:absolute;top:100%;left:0;margin-top:4px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:100;min-width:300px;max-height:280px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.4)">
            <div style="display:flex;gap:6px;margin-bottom:8px">
              <button class="btn" style="font-size:11px;padding:4px 10px" onclick="selectAllModels()">All</button>
              <button class="btn" style="font-size:11px;padding:4px 10px;background:var(--surface2)" onclick="selectNoModels()">None</button>
            </div>
            <div id="modelCheckboxes" style="font-size:13px"></div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          <button class="btn-outline" data-hours="1" onclick="setRange(1)">1h</button>
          <button class="btn-outline" data-hours="3" onclick="setRange(3)">3h</button>
          <button class="btn-outline" data-hours="6" onclick="setRange(6)">6h</button>
          <button class="btn-outline" data-hours="12" onclick="setRange(12)">12h</button>
          <button class="btn-outline active" data-hours="24" onclick="setRange(24)">24h</button>
          <button class="btn-outline" data-hours="72" onclick="setRange(72)">3d</button>
          <button class="btn-outline" data-hours="168" onclick="setRange(168)">7d</button>
          <button class="btn-outline" data-hours="720" onclick="setRange(720)">30d</button>
        </div>
        <button class="btn" id="refreshBtn" onclick="refresh()">↻ Refresh</button>
        <button class="btn" id="demoBtn" onclick="toggleDemo()" style="background:var(--surface2);border:1px solid var(--border)">🎭 Demo</button>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="color:var(--muted);font-size:13px">👤 ${username}</span>
        ${role === 'admin' ? '<a href="/admin" style="color:var(--accent);font-size:13px;text-decoration:none">⚙ Admin</a>' : ''}
        <button class="btn" style="background:#475569" onclick="logout()">Logout</button>
      </div>
    </div>
  </header>

  <!-- Chat Agent -->
  <div class="card" style="margin-bottom:20px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;cursor:pointer" onclick="toggleChat()">
      <span style="font-size:22px">🤖</span>
      <div style="flex:1">
        <div style="font-size:15px;font-weight:600">Capacity Assistant</div>
        <div style="font-size:12px;color:var(--muted)">Ask about usage, predictions, limits, or request a quota increase</div>
      </div>
      <span id="chatToggleIcon" style="font-size:18px;color:var(--muted)">▼</span>
    </div>
    <div id="chatBody">
    <div id="chatMsgs" style="max-height:300px;overflow-y:auto;margin-bottom:14px;display:flex;flex-direction:column;gap:10px">
      <div class="msg bot"><div class="bubble">Hi! I can help you understand your Bedrock usage, predict when you might hit limits, and guide you through requesting quota increases. Try asking:<br><br>
        • <em>Which models are closest to their limits?</em><br>
        • <em>When will I run out of capacity for Claude?</em><br>
        • <em>Help me request a quota increase</em><br>
        • <em>What's my usage trend over the last week?</em>
      </div></div>
    </div>
    <div style="display:flex;gap:8px">
      <input id="chatIn" style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-size:14px;outline:none" placeholder="Ask about your capacity..." onkeypress="if(event.key==='Enter')sendChat()" />
      <button class="btn" id="chatSend" onclick="sendChat()">Send</button>
    </div>
    <div id="increasePanel" class="hidden" style="margin-top:14px;padding:16px;background:var(--bg);border:1px solid var(--border);border-radius:8px">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">📋 Request Quota Increase</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Region</label>
          <select id="incRegion" style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px;font-size:13px">
            <option value="us-east-1">US East (N. Virginia)</option>
            <option value="us-west-2">US West (Oregon)</option>
            <option value="eu-west-1">EU (Ireland)</option>
            <option value="eu-west-2">EU (London)</option>
            <option value="eu-central-1">EU (Frankfurt)</option>
            <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
            <option value="ap-southeast-2">Asia Pacific (Sydney)</option>
            <option value="ap-northeast-1">Asia Pacific (Tokyo)</option>
            <option value="ca-central-1">Canada (Central)</option>
            <option value="sa-east-1">South America (São Paulo)</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Service</label>
          <select id="incService" style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px;font-size:13px">
            <option value="bedrock">Bedrock</option>
            <option value="bedrock-runtime">Bedrock Runtime</option>
            <option value="bedrock-agent">Bedrock Agent</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Desired Value</label>
          <input id="incValue" type="number" style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px;font-size:13px" placeholder="e.g. 2000000" />
        </div>
      </div>
      <div style="margin-bottom:10px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Quota Code</label>
        <select id="incQuota" style="width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px;font-size:13px">
          <option value="">Loading quotas...</option>
        </select>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" onclick="submitIncrease()">Submit Request</button>
        <button class="btn" style="background:var(--surface2)" onclick="hideIncreasePanel()">Cancel</button>
      </div>
      <div id="increaseResult" style="margin-top:10px;font-size:13px"></div>
    </div>
  </div>
  </div>

  <!-- Summary cards -->
  <div class="grid grid-4" id="summaryCards">
    <div class="card"><div class="card-title">Total Invocations</div><div class="stat-value" id="totalInvocations">—</div><div class="stat-sub">across all models</div></div>
    <div class="card"><div class="card-title">Active Models</div><div class="stat-value" id="activeModels">—</div><div class="stat-sub">with CloudWatch data</div></div>
    <div class="card"><div class="card-title">Agent Invocations</div><div class="stat-value" id="agentInv">—</div><div class="stat-sub">Bedrock Agents</div></div>
    <div class="card"><div class="card-title">KB Queries</div><div class="stat-value" id="kbQueries">—</div><div class="stat-sub">Knowledge Base</div></div>
  </div>

  <!-- View Selector -->
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
    <span style="color:var(--muted);font-size:13px">View</span>
    <select id="viewSelect" onchange="setView(this.value)" style="background:var(--surface);color:var(--text);border:1px solid var(--border);padding:8px 12px;border-radius:8px;font-size:13px">
      <option value="all" selected>All Metrics</option>
      <option value="model">Model</option>
      <option value="agent">AgentCore</option>
    </select>
  </div>

  <!-- Charts -->
  <div id="modelCharts">
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Tokens Per Minute (TPM)</div>
      <div class="chart-desc">Combined input + output tokens per minute per model. Red line shows your quota limit. Approaching the limit may cause throttling.</div>
      <div class="chart-wrap"><canvas id="tpmChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Requests Per Minute (RPM)</div>
      <div class="chart-desc">Number of model invocations per minute. Red line shows your quota limit. Spikes near the limit indicate you may need a quota increase.</div>
      <div class="chart-wrap"><canvas id="rpmChart"></canvas></div>
    </div>
  </div>
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Model Invocations Over Time</div>
      <div class="chart-desc">Total number of API calls to each model over the selected time window. Useful for tracking usage trends and identifying peak periods.</div>
      <div class="chart-wrap"><canvas id="invocationsChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Token Usage Over Time</div>
      <div class="chart-desc">Input and output token consumption per model. Tracks prompt sizes (input) and completion lengths (output) to help manage costs.</div>
      <div class="chart-wrap"><canvas id="tokensChart"></canvas></div>
    </div>
  </div>
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Invocation Latency (ms)</div>
      <div class="chart-desc">Average response time in milliseconds per model. Higher latency may indicate model load or larger prompt/response sizes.</div>
      <div class="chart-wrap"><canvas id="latencyChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Model Invocations</div>
      <div class="chart-desc">Breakdown of total invocations by model for the selected time window. Shows which models are most heavily used.</div>
      <div class="chart-wrap"><canvas id="pieChart"></canvas></div>
    </div>
  </div>
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Latency Percentiles (p50 / p90 / p99)</div>
      <div class="chart-desc">Response time distribution. p50 = typical request, p90 = slower requests, p99 = worst case. Large gaps between p50 and p99 suggest inconsistent performance.</div>
      <div class="chart-wrap"><canvas id="latencyPercentilesChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Errors &amp; Throttles</div>
      <div class="chart-desc">Client errors (4xx), server errors (5xx), and throttled requests. Throttles mean you've hit a quota limit. Persistent 5xx errors may indicate a service issue.</div>
      <div class="chart-wrap"><canvas id="errorsChart"></canvas></div>
    </div>
  </div>
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Token Input / Output Ratio</div>
      <div class="chart-desc">Ratio of input tokens to output tokens. A rising ratio may indicate prompt bloat. A falling ratio suggests longer model responses relative to input.</div>
      <div class="chart-wrap"><canvas id="tokenRatioChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Throttle Rate (%)</div>
      <div class="chart-desc">Percentage of requests that were throttled. Any value above 0% means you're hitting capacity limits and should consider requesting a quota increase.</div>
      <div class="chart-wrap"><canvas id="throttleRateChart"></canvas></div>
    </div>
  </div>
  </div>

  <!-- AgentCore Metrics -->
  <div id="agentCharts">
  <div style="margin-bottom:8px;margin-top:24px"><span style="font-size:16px;font-weight:600;color:var(--accent)">🤖 AgentCore Metrics</span></div>
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Agent Invocations & Errors</div>
      <div class="chart-desc">Agent invocation volume and error count. Rising errors may indicate misconfigured agents or downstream tool failures.</div>
      <div class="chart-wrap"><canvas id="agentInvChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Agent Latency (p50 / p90 / p99)</div>
      <div class="chart-desc">End-to-end agent response time. Includes all tool calls and LLM invocations within the agent workflow.</div>
      <div class="chart-wrap"><canvas id="agentLatencyChart"></canvas></div>
    </div>
  </div>
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Agent Step Count</div>
      <div class="chart-desc">Number of steps (tool calls / reasoning loops) per agent invocation. More steps = higher cost and latency.</div>
      <div class="chart-wrap"><canvas id="agentStepChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Knowledge Base Retrieval</div>
      <div class="chart-desc">RAG retrieval volume, latency, and errors. High latency may indicate large vector stores or complex queries.</div>
      <div class="chart-wrap"><canvas id="kbChart"></canvas></div>
    </div>
  </div>
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Guardrail Activity</div>
      <div class="chart-desc">Guardrail invocations vs interventions (blocked content). A high intervention rate may indicate overly strict rules or misuse attempts.</div>
      <div class="chart-wrap"><canvas id="guardrailChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title">Knowledge Base Errors</div>
      <div class="chart-desc">Failed retrieval operations. Persistent errors may indicate index issues, permission problems, or data source connectivity.</div>
      <div class="chart-wrap"><canvas id="kbErrorChart"></canvas></div>
    </div>
  </div>
  </div>

  <!-- Quotas & Predictions -->
  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">Service Quotas</div>
      <div id="quotasList" class="loading">Loading quotas...</div>
    </div>
    <div class="card">
      <div class="card-title">Predictions & Alerts</div>
      <div id="predictionsList" class="loading">Loading predictions...</div>
    </div>
  </div>

  <div style="text-align:center;padding:16px 0;color:var(--muted);font-size:12px" id="lastUpdate">Loading...</div>
</div>


<script>
const COLORS = ['#3b82f6','#8b5cf6','#22c55e','#eab308','#ef4444','#f97316','#06b6d4','#ec4899'];
let currentHours = 24;
let currentRegion = 'us-east-1';
let currentAccountId = '';
let demoMode = false;
let orgAccounts = [];
let charts = {};
let allModels = [];
let selectedModels = new Set();
let quotaLimits = { invocations: null, inputTokens: null, outputTokens: null };

function regionParam() { return 'region=' + currentRegion; }
function accountParam() { return currentAccountId ? '&accountId=' + currentAccountId : ''; }

async function loadAccounts() {
  try {
    var res = await fetch('/api/v2/accounts');
    var data = await res.json();
    orgAccounts = data.accounts || [];
    renderAcctDropdown(orgAccounts);
  } catch (e) {
    orgAccounts = [];
    renderAcctDropdown([]);
  }
}

function renderAcctDropdown(accounts) {
  var dd = document.getElementById('acctDropdown');
  var html = '<div class="acct-dropdown-item' + (!currentAccountId ? ' selected' : '') + '" onclick="selectAccount(\\'\\', \\'Current Account\\')">Current Account</div>';
  accounts.forEach(function(a) {
    var display = a.accountName + ' (' + a.accountId + ')';
    var sel = currentAccountId === a.accountId ? ' selected' : '';
    html += '<div class="acct-dropdown-item' + sel + '" onclick="selectAccount(\\'' + a.accountId + '\\', \\'' + display.replace(/'/g, "\\\\'") + '\\')">' + display + '</div>';
  });
  dd.innerHTML = html;
}

function filterAccounts(query) {
  if (!query) { renderAcctDropdown(orgAccounts); return; }
  var q = query.toLowerCase();
  var filtered = orgAccounts.filter(function(a) {
    return a.accountName.toLowerCase().indexOf(q) !== -1 || a.accountId.toLowerCase().indexOf(q) !== -1;
  });
  renderAcctDropdown(filtered);
  document.getElementById('acctDropdown').classList.add('open');
}

function openAcctDropdown() {
  renderAcctDropdown(orgAccounts);
  document.getElementById('acctDropdown').classList.add('open');
}

function selectAccount(accountId, displayName) {
  currentAccountId = accountId;
  document.getElementById('acctSearch').value = displayName;
  document.getElementById('acctDropdown').classList.remove('open');
  if (accountId) {
    document.getElementById('accountBadge').textContent = displayName;
  } else {
    loadAccount();
  }
  loadAll();
}

// Close account dropdown when clicking outside
document.addEventListener('click', function(e) {
  var sel = document.querySelector('.acct-selector');
  if (sel && !sel.contains(e.target)) {
    document.getElementById('acctDropdown').classList.remove('open');
  }
});

function isModelSelected(modelId) {
  return selectedModels.size === 0 || selectedModels.has(modelId);
}

function toggleModelDropdown() {
  document.getElementById('modelDropdown').classList.toggle('hidden');
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  const dd = document.getElementById('modelDropdown');
  const btn = document.getElementById('modelFilterBtn');
  if (!dd.contains(e.target) && e.target !== btn) dd.classList.add('hidden');
});

function updateModelButton() {
  const btn = document.getElementById('modelFilterBtn');
  if (selectedModels.size === 0 || selectedModels.size === allModels.length) {
    btn.textContent = 'All Models ▾';
  } else if (selectedModels.size === 1) {
    btn.textContent = shortName(Array.from(selectedModels)[0]) + ' ▾';
  } else {
    btn.textContent = selectedModels.size + ' Models ▾';
  }
}

function renderModelCheckboxes() {
  const container = document.getElementById('modelCheckboxes');
  container.innerHTML = allModels.map(m => {
    const checked = selectedModels.size === 0 || selectedModels.has(m) ? 'checked' : '';
    return \`<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;color:var(--text)">
      <input type="checkbox" \${checked} onchange="toggleModel('\${m}')" style="accent-color:var(--accent)" />
      <span>\${shortName(m)}</span>
    </label>\`;
  }).join('');
}

function toggleModel(modelId) {
  if (selectedModels.size === 0) {
    // First deselection: select all except this one
    selectedModels = new Set(allModels.filter(m => m !== modelId));
  } else if (selectedModels.has(modelId)) {
    selectedModels.delete(modelId);
    if (selectedModels.size === 0) { selectedModels = new Set(allModels); }
  } else {
    selectedModels.add(modelId);
  }
  if (selectedModels.size === allModels.length) selectedModels = new Set();
  updateModelButton();
  renderModelCheckboxes();
  applyModelFilter();
}

function selectAllModels() {
  selectedModels = new Set();
  updateModelButton();
  renderModelCheckboxes();
  applyModelFilter();
}

function selectNoModels() {
  if (allModels.length > 0) {
    selectedModels = new Set([allModels[0]]);
  }
  updateModelButton();
  renderModelCheckboxes();
  applyModelFilter();
}

function applyModelFilter() {
  // Re-render charts and data with current filter
  loadTimeSeries();
  loadUsagePie();
  loadPredictions();
}

function shortName(id) { return id.split('.').pop() || id; }

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
}

function setRange(h) {
  currentHours = h;
  document.querySelectorAll('[data-hours]').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.hours) === h);
  });
  loadTimeSeries();
  loadUsagePie();
}

function setRegion(r) {
  currentRegion = r;
  loadAll();
}

function setView(v) {
  var model = document.getElementById('modelCharts');
  var agent = document.getElementById('agentCharts');
  if (v === 'model') { model.style.display = ''; agent.style.display = 'none'; }
  else if (v === 'agent') { model.style.display = 'none'; agent.style.display = ''; }
  else { model.style.display = ''; agent.style.display = ''; }
}

function toggleChat() {
  var body = document.getElementById('chatBody');
  var icon = document.getElementById('chatToggleIcon');
  if (body.style.display === 'none') {
    body.style.display = '';
    icon.textContent = '▼';
  } else {
    body.style.display = 'none';
    icon.textContent = '▶';
  }
}

function toggleDemo() {
  demoMode = !demoMode;
  var btn = document.getElementById('demoBtn');
  if (demoMode) {
    btn.style.background = '#8b5cf6';
    btn.style.border = '1px solid #8b5cf6';
    btn.style.color = '#fff';
    btn.textContent = '🎭 Demo ON';
    document.getElementById('accountBadge').textContent = 'DEMO MODE';
  } else {
    btn.style.background = 'var(--surface2)';
    btn.style.border = '1px solid var(--border)';
    btn.style.color = 'var(--text)';
    btn.textContent = '🎭 Demo';
    loadAccount();
  }
  loadAll();
}

async function refresh() {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true; btn.textContent = '↻ Loading...';
  await loadAll();
  btn.disabled = false; btn.textContent = '↻ Refresh';
}

function buildLimitAnnotations(limitValue, label) {
  if (!limitValue || limitValue <= 0) return {};
  return {
    annotation: {
      annotations: {
        limitLine: {
          type: 'line',
          yMin: limitValue,
          yMax: limitValue,
          borderColor: '#ef4444',
          borderWidth: 2,
          borderDash: [6, 4],
          label: {
            display: true,
            content: label || ('Limit: ' + limitValue.toLocaleString()),
            position: 'start',
            backgroundColor: 'rgba(239, 68, 68, 0.8)',
            color: '#fff',
            font: { size: 11, weight: 'bold' },
            padding: 4
          }
        }
      }
    }
  };
}

function getChartTimeRange() {
  var h = currentHours || 24;
  return {
    min: new Date(Date.now() - h * 60 * 60 * 1000).toISOString(),
    max: new Date().toISOString(),
    unit: h <= 12 ? 'hour' : h <= 48 ? 'hour' : h <= 168 ? 'day' : 'day'
  };
}

function makeChart(id, type, data, options = {}) {
  if (charts[id]) charts[id].destroy();
  var ctx = document.getElementById(id).getContext('2d');
  var isTimeSeries = (type !== 'pie' && type !== 'doughnut');
  var range = getChartTimeRange();
  var baseScales = {};
  if (isTimeSeries) {
    baseScales = {
      x: {
        type: 'time',
        min: range.min,
        max: range.max,
        time: {
          unit: range.unit,
          tooltipFormat: 'MMM d, HH:mm',
          displayFormats: { hour: 'HH:mm', day: 'MMM d' }
        },
        ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 12 },
        grid: { color: '#1e293b' }
      },
      y: { beginAtZero: true, ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } }
    };
  }
  var basePlugins = { legend: { labels: { color: '#94a3b8', font: { size: 11 } } } };
  if (options.plugins) {
    Object.assign(basePlugins, options.plugins);
    delete options.plugins;
  }
  var mergedOptions = Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    plugins: basePlugins,
    scales: baseScales
  }, options);
  charts[id] = new Chart(ctx, { type: type, data: data, options: mergedOptions });
}

async function loadTimeSeries() {
  try {
    const res = await fetch('/api/timeseries?hours=' + currentHours + '&' + regionParam() + accountParam());
    const data = await res.json();
    if (data.error) { console.warn('timeseries:', data.error); return; }
    const rawSeries = data.series || [];
    const series = rawSeries.filter(s => isModelSelected(s.modelId));
    renderModelCharts(series);
  } catch (e) { console.error('timeseries error', e); }
}

function renderModelCharts(series) {
  try {
    // Calculate period in minutes for per-minute rate conversion
    var h = currentHours || 24;
    var periodMinutes = h <= 1 ? 5 : h <= 12 ? 15 : h <= 72 ? 60 : 1440;

    // TPM chart (Tokens Per Minute = total tokens / period minutes)
    var tpmDatasets = [];
    series.forEach(function(s, i) {
      var inputData = s.inputTokens.map(function(p) { return { x: new Date(p.timestamp), y: Math.round(p.value / periodMinutes) }; });
      var outputData = s.outputTokens.map(function(p) { return { x: new Date(p.timestamp), y: Math.round(p.value / periodMinutes) }; });
      var combinedMap = {};
      inputData.forEach(function(p) { combinedMap[p.x.toISOString()] = (combinedMap[p.x.toISOString()] || 0) + p.y; });
      outputData.forEach(function(p) { combinedMap[p.x.toISOString()] = (combinedMap[p.x.toISOString()] || 0) + p.y; });
      var combined = Object.keys(combinedMap).sort().map(function(k) { return { x: new Date(k), y: combinedMap[k] }; });
      if (combined.length) {
        tpmDatasets.push({ label: shortName(s.modelId), data: combined, borderColor: COLORS[i % COLORS.length], backgroundColor: COLORS[i % COLORS.length] + '20', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
      }
    });
    var tpmAnnotations = {};
    if (quotaLimits.inputTokens) {
      tpmAnnotations.tpmLimit = { type: 'line', yMin: quotaLimits.inputTokens, yMax: quotaLimits.inputTokens, borderColor: '#ef4444', borderWidth: 2, borderDash: [6, 4], label: { display: true, content: 'TPM Limit: ' + quotaLimits.inputTokens.toLocaleString(), position: 'start', backgroundColor: 'rgba(239,68,68,0.8)', color: '#fff', font: { size: 11, weight: 'bold' }, padding: 4 } };
    }
    makeChart('tpmChart', 'line', { datasets: tpmDatasets.length ? tpmDatasets : [{ label: 'No data', data: [] }] }, Object.keys(tpmAnnotations).length ? { plugins: { annotation: { annotations: tpmAnnotations } } } : {});

    // RPM chart (Requests Per Minute = invocations / period minutes)
    makeChart('rpmChart', 'line', {
      datasets: series.map(function(s, i) {
        return {
          label: shortName(s.modelId),
          data: s.invocations.map(function(p) { return { x: new Date(p.timestamp), y: Math.round(p.value / periodMinutes) }; }),
          borderColor: COLORS[i % COLORS.length],
          backgroundColor: COLORS[i % COLORS.length] + '20',
          fill: true, tension: .3, pointRadius: 2, borderWidth: 2,
        };
      }),
    }, { plugins: buildLimitAnnotations(quotaLimits.invocations, 'RPM Limit: ' + (quotaLimits.invocations || '').toLocaleString()) });

    // Invocations chart
    makeChart('invocationsChart', 'line', {
      datasets: series.map((s, i) => ({
        label: shortName(s.modelId),
        data: s.invocations.map(p => ({ x: new Date(p.timestamp), y: p.value })),
        borderColor: COLORS[i % COLORS.length],
        backgroundColor: COLORS[i % COLORS.length] + '20',
        fill: true, tension: .3, pointRadius: 2, borderWidth: 2,
      })),
    }, { plugins: buildLimitAnnotations(quotaLimits.invocations, 'Invocations Limit: ' + (quotaLimits.invocations || '').toLocaleString()) });

    // Tokens chart
    const tokenDatasets = [];
    series.forEach((s, i) => {
      if (s.inputTokens.length) {
        tokenDatasets.push({
          label: shortName(s.modelId) + ' input',
          data: s.inputTokens.map(p => ({ x: new Date(p.timestamp), y: p.value })),
          borderColor: COLORS[i % COLORS.length],
          backgroundColor: COLORS[i % COLORS.length] + '30',
          fill: true, tension: .3, pointRadius: 1, borderWidth: 1.5,
        });
      }
      if (s.outputTokens.length) {
        tokenDatasets.push({
          label: shortName(s.modelId) + ' output',
          data: s.outputTokens.map(p => ({ x: new Date(p.timestamp), y: p.value })),
          borderColor: COLORS[(i + 4) % COLORS.length],
          backgroundColor: COLORS[(i + 4) % COLORS.length] + '30',
          fill: true, tension: .3, pointRadius: 1, borderWidth: 1.5, borderDash: [4, 2],
        });
      }
    });
    var tokenAnnotations = {};
    if (quotaLimits.inputTokens) {
      tokenAnnotations.inputLimit = { type: 'line', yMin: quotaLimits.inputTokens, yMax: quotaLimits.inputTokens, borderColor: '#ef4444', borderWidth: 2, borderDash: [6, 4], label: { display: true, content: 'Input Token Limit: ' + quotaLimits.inputTokens.toLocaleString(), position: 'start', backgroundColor: 'rgba(239,68,68,0.8)', color: '#fff', font: { size: 11, weight: 'bold' }, padding: 4 } };
    }
    if (quotaLimits.outputTokens) {
      tokenAnnotations.outputLimit = { type: 'line', yMin: quotaLimits.outputTokens, yMax: quotaLimits.outputTokens, borderColor: '#f97316', borderWidth: 2, borderDash: [6, 4], label: { display: true, content: 'Output Token Limit: ' + quotaLimits.outputTokens.toLocaleString(), position: 'end', backgroundColor: 'rgba(249,115,22,0.8)', color: '#fff', font: { size: 11, weight: 'bold' }, padding: 4 } };
    }
    var tokenPluginOpts = Object.keys(tokenAnnotations).length ? { plugins: { annotation: { annotations: tokenAnnotations } } } : {};
    makeChart('tokensChart', 'line', { datasets: tokenDatasets.length ? tokenDatasets : [{ label: 'No data', data: [] }] }, tokenPluginOpts);

    // Latency chart (average)
    makeChart('latencyChart', 'line', {
      datasets: series.map((s, i) => ({
        label: shortName(s.modelId),
        data: s.latency.map(p => ({ x: new Date(p.timestamp), y: p.value })),
        borderColor: COLORS[i % COLORS.length],
        tension: .3, pointRadius: 2, borderWidth: 2, fill: false,
      })),
    });

    // Latency percentiles chart
    var percDatasets = [];
    series.forEach(function(s, i) {
      var name = shortName(s.modelId);
      var color = COLORS[i % COLORS.length];
      if (s.latencyP50 && s.latencyP50.length) percDatasets.push({ label: name + ' p50', data: s.latencyP50.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: color, borderWidth: 1.5, borderDash: [2, 2], tension: .3, pointRadius: 1, fill: false });
      if (s.latencyP90 && s.latencyP90.length) percDatasets.push({ label: name + ' p90', data: s.latencyP90.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: color, borderWidth: 2, tension: .3, pointRadius: 1, fill: false });
      if (s.latencyP99 && s.latencyP99.length) percDatasets.push({ label: name + ' p99', data: s.latencyP99.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: color, borderWidth: 2.5, borderDash: [6, 3], tension: .3, pointRadius: 1, fill: false });
    });
    makeChart('latencyPercentilesChart', 'line', { datasets: percDatasets.length ? percDatasets : [{ label: 'No data', data: [] }] });

    // Errors & Throttles chart
    var errorDatasets = [];
    series.forEach(function(s, i) {
      var name = shortName(s.modelId);
      if (s.clientErrors && s.clientErrors.length) errorDatasets.push({ label: name + ' 4xx', data: s.clientErrors.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#eab308', backgroundColor: '#eab30830', fill: true, tension: .3, pointRadius: 1, borderWidth: 2 });
      if (s.serverErrors && s.serverErrors.length) errorDatasets.push({ label: name + ' 5xx', data: s.serverErrors.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#ef4444', backgroundColor: '#ef444430', fill: true, tension: .3, pointRadius: 1, borderWidth: 2 });
      if (s.throttles && s.throttles.length) errorDatasets.push({ label: name + ' throttles', data: s.throttles.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#f97316', backgroundColor: '#f9731630', fill: true, tension: .3, pointRadius: 1, borderWidth: 2 });
    });
    makeChart('errorsChart', 'line', { datasets: errorDatasets.length ? errorDatasets : [{ label: 'No data', data: [] }] });

    // Token Input/Output Ratio chart
    var ratioDatasets = [];
    series.forEach(function(s, i) {
      var name = shortName(s.modelId);
      if (s.inputTokens.length && s.outputTokens.length) {
        var ratioMap = {};
        s.inputTokens.forEach(function(p) { ratioMap[p.timestamp] = { input: p.value, output: 0 }; });
        s.outputTokens.forEach(function(p) { if (ratioMap[p.timestamp]) ratioMap[p.timestamp].output = p.value; });
        var ratioData = Object.keys(ratioMap).sort().map(function(ts) {
          var r = ratioMap[ts];
          return { x: new Date(ts), y: r.output > 0 ? +(r.input / r.output).toFixed(2) : 0 };
        });
        ratioDatasets.push({ label: name, data: ratioData, borderColor: COLORS[i % COLORS.length], tension: .3, pointRadius: 2, borderWidth: 2, fill: false });
      }
    });
    makeChart('tokenRatioChart', 'line', { datasets: ratioDatasets.length ? ratioDatasets : [{ label: 'No data', data: [] }] });

    // Throttle Rate chart (throttles / invocations * 100)
    var throttleRateDatasets = [];
    series.forEach(function(s, i) {
      var name = shortName(s.modelId);
      if (s.throttles && s.throttles.length && s.invocations.length) {
        var invMap = {};
        s.invocations.forEach(function(p) { invMap[p.timestamp] = p.value; });
        var rateData = s.throttles.map(function(p) {
          var inv = invMap[p.timestamp] || 0;
          return { x: new Date(p.timestamp), y: inv > 0 ? +((p.value / inv) * 100).toFixed(2) : 0 };
        });
        throttleRateDatasets.push({ label: name, data: rateData, borderColor: COLORS[i % COLORS.length], backgroundColor: COLORS[i % COLORS.length] + '20', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
      }
    });
    makeChart('throttleRateChart', 'line', { datasets: throttleRateDatasets.length ? throttleRateDatasets : [{ label: 'No data', data: [] }] });

  } catch (e) { console.error('renderModelCharts error', e); }
}

async function loadUsagePie() {
  try {
    const res = await fetch('/api/usage?hours=' + (currentHours || 24) + '&' + regionParam() + accountParam());
    const data = await res.json();
    if (data.error) { document.getElementById('totalInvocations').textContent = '—'; return; }
    const rawUsage = data.usage || [];
    const usage = rawUsage.filter(u => isModelSelected(u.modelId));
    const labels = usage.map(u => shortName(u.modelId));
    const values = usage.map(u => u.invocations);
    const total = values.reduce((a, b) => a + b, 0);
    document.getElementById('totalInvocations').textContent = total.toLocaleString();

    makeChart('pieChart', 'doughnut', {
      labels,
      datasets: [{ data: values, backgroundColor: COLORS.slice(0, labels.length), borderWidth: 0 }],
    }, {
      plugins: { legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 11 }, padding: 12 } } },
    });
  } catch (e) { console.error('usage error', e); }
}

async function loadAgents() {
  try {
    const res = await fetch('/api/agents?' + regionParam() + accountParam());
    const data = await res.json();
    if (data.error) { document.getElementById('agentInv').textContent = '—'; document.getElementById('kbQueries').textContent = '—'; return; }
    const agentMetrics = data.agentMetrics || {};
    document.getElementById('agentInv').textContent = (agentMetrics.agentInvocations || 0).toLocaleString();
    document.getElementById('kbQueries').textContent = (agentMetrics.knowledgeBaseQueries || 0).toLocaleString();
  } catch (e) { document.getElementById('agentInv').textContent = '—'; document.getElementById('kbQueries').textContent = '—'; }
}

async function loadActiveModels() {
  try {
    const res = await fetch('/api/active-models?' + regionParam() + accountParam());
    const data = await res.json();
    if (data.error) { document.getElementById('activeModels').textContent = '—'; return; }
    const models = data.models || [];
    document.getElementById('activeModels').textContent = models.length || config_models_count;
    // Update model filter if the list changed
    if (JSON.stringify(models.sort()) !== JSON.stringify(allModels.sort())) {
      allModels = models.sort();
      renderModelCheckboxes();
      updateModelButton();
    }
  } catch (e) { document.getElementById('activeModels').textContent = '—'; }
}
const config_models_count = ${config.models.length};

async function loadQuotas() {
  try {
    const res = await fetch('/api/quotas?' + regionParam() + accountParam());
    const data = await res.json();
    const el = document.getElementById('quotasList');
    if (data.error) { el.innerHTML = '<div class="loading">' + data.error + '</div>'; return; }
    const quotas = data.quotas || [];
    if (!quotas.length) { el.innerHTML = '<div class="loading">No quotas found</div>'; return; }
    el.innerHTML = quotas.slice(0, 15).map(q => \`
      <div class="quota-row">
        <div class="quota-name">\${q.adjustable ? '✓' : '✗'} \${q.quotaName}</div>
        <div class="quota-val">\${q.value.toLocaleString()} \${q.unit}</div>
      </div>
    \`).join('');

    // Extract limits for chart annotations
    var invQ = quotas.find(q => q.quotaName.toLowerCase().includes('invocations per minute') || q.quotaName.toLowerCase().includes('invoke model'));
    var inTokQ = quotas.find(q => q.quotaName.toLowerCase().includes('input token') && q.quotaName.toLowerCase().includes('per minute'));
    var outTokQ = quotas.find(q => q.quotaName.toLowerCase().includes('output token') && q.quotaName.toLowerCase().includes('per minute'));
    quotaLimits.invocations = invQ ? invQ.value : null;
    quotaLimits.inputTokens = inTokQ ? inTokQ.value : null;
    quotaLimits.outputTokens = outTokQ ? outTokQ.value : null;
  } catch (e) { document.getElementById('quotasList').innerHTML = '<div class="loading">Error loading quotas</div>'; }
}

async function loadPredictions() {
  try {
    const res = await fetch('/api/predictions?' + regionParam() + accountParam());
    const data = await res.json();
    if (data.error) { document.getElementById('predictionsList').innerHTML = '<div class="loading">' + data.error + '</div>'; return; }
    const rawPredictions = data.predictions || [];
    const predictions = rawPredictions.filter(p => isModelSelected(p.modelId));
    const el = document.getElementById('predictionsList');
    if (!predictions.length) { el.innerHTML = '<div class="loading">No predictions</div>'; return; }
    el.innerHTML = predictions.map(p => {
      const level = p.utilizationPercent > 90 ? 'crit' : p.utilizationPercent > 80 ? 'warn' : '';
      const badgeClass = p.utilizationPercent > 90 ? 'badge-crit' : p.utilizationPercent > 80 ? 'badge-warn' : 'badge-ok';
      const badgeText = p.utilizationPercent > 90 ? 'CRITICAL' : p.utilizationPercent > 80 ? 'WARNING' : 'OK';
      const barColor = p.utilizationPercent > 90 ? 'var(--red)' : p.utilizationPercent > 80 ? 'var(--yellow)' : 'var(--accent)';
      return \`
        <div class="prediction-card \${level}">
          <div class="pred-header">
            <span class="pred-model">\${shortName(p.modelId)}</span>
            <span class="badge \${badgeClass}">\${badgeText}</span>
          </div>
          <div class="pred-row"><span>Usage</span><span>\${p.currentUsage.toFixed(0)}</span></div>
          <div class="pred-row"><span>Limit</span><span>\${p.quotaLimit.toLocaleString()}</span></div>
          <div class="pred-row"><span>Utilization</span><span>\${p.utilizationPercent.toFixed(1)}%</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:\${Math.min(p.utilizationPercent,100)}%;background:\${barColor}"></div></div>
          \${p.predictedExhaustionDate ? \`<div class="pred-row" style="margin-top:8px"><span>⚠️ Exhaustion</span><span>\${new Date(p.predictedExhaustionDate).toLocaleDateString()}</span></div>\` : ''}
          <div class="pred-rec">\${p.recommendation}</div>
        </div>
      \`;
    }).join('');
  } catch (e) { document.getElementById('predictionsList').innerHTML = '<div class="loading">Error loading predictions</div>'; }
}

async function sendChat() {
  const input = document.getElementById('chatIn');
  const msg = input.value.trim();
  if (!msg) return;
  const msgs = document.getElementById('chatMsgs');
  msgs.innerHTML += \`<div class="msg user"><div class="bubble">\${msg}</div></div>\`;
  input.value = '';
  const btn = document.getElementById('chatSend');
  btn.disabled = true; btn.textContent = 'Thinking...';
  msgs.scrollTop = msgs.scrollHeight;
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg, region: currentRegion }) });
    const data = await res.json();
    let reply = data.response || 'No response';
    // If the response mentions requesting an increase, show the panel
    if (reply.toLowerCase().includes('request') && reply.toLowerCase().includes('increase') || msg.toLowerCase().includes('request') && msg.toLowerCase().includes('increase')) {
      showIncreasePanel();
    }
    msgs.innerHTML += \`<div class="msg bot"><div class="bubble">\${reply}</div></div>\`;
  } catch (e) {
    msgs.innerHTML += \`<div class="msg bot"><div class="bubble">Sorry, something went wrong.</div></div>\`;
  }
  btn.disabled = false; btn.textContent = 'Send';
  msgs.scrollTop = msgs.scrollHeight;
}

// Clickable suggestion prompts
document.getElementById('chatMsgs').addEventListener('click', function(e) {
  if (e.target.tagName === 'EM') {
    document.getElementById('chatIn').value = e.target.textContent;
    sendChat();
  }
});

async function showIncreasePanel() {
  const panel = document.getElementById('increasePanel');
  panel.classList.remove('hidden');
  document.getElementById('increaseResult').textContent = '';
  // Default region to the dashboard's configured region
  const regionSel = document.getElementById('incRegion');
  regionSel.value = currentRegion === 'all' ? '${config.region}' : currentRegion;
  // Load quotas for the selected increase region
  try {
    const res = await fetch('/api/quotas?region=' + regionSel.value + accountParam());
    const { quotas } = await res.json();
    const sel = document.getElementById('incQuota');
    sel.innerHTML = quotas
      .filter(q => q.adjustable)
      .map(q => \`<option value="\${q.quotaCode}">\${q.quotaName} (current: \${q.value})</option>\`)
      .join('');
    if (!sel.innerHTML) sel.innerHTML = '<option value="">No adjustable quotas found</option>';
  } catch { }
}

function hideIncreasePanel() {
  document.getElementById('increasePanel').classList.add('hidden');
}

async function submitIncrease() {
  const region = document.getElementById('incRegion').value;
  const service = document.getElementById('incService').value;
  const quotaCode = document.getElementById('incQuota').value;
  const desiredValue = parseFloat(document.getElementById('incValue').value);
  const resultEl = document.getElementById('increaseResult');

  if (!quotaCode) { resultEl.innerHTML = '<span style="color:var(--red)">Select a quota</span>'; return; }
  if (!desiredValue || desiredValue <= 0) { resultEl.innerHTML = '<span style="color:var(--red)">Enter a valid desired value</span>'; return; }

  resultEl.innerHTML = '<span style="color:var(--muted)">Submitting request...</span>';
  try {
    const res = await fetch('/api/request-increase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceCode: service, quotaCode, desiredValue, region }),
    });
    const data = await res.json();
    if (data.requestId) {
      resultEl.innerHTML = \`<span style="color:var(--green)">✓ Request submitted! ID: \${data.requestId}</span>\`;
      const msgs = document.getElementById('chatMsgs');
      msgs.innerHTML += \`<div class="msg bot"><div class="bubble">✅ Quota increase request submitted!\\n\\nRequest ID: \${data.requestId}\\nRegion: \${region}\\nService: \${service}\\nQuota: \${quotaCode}\\nDesired Value: \${desiredValue}\\n\\nYou can track this in the AWS Service Quotas console.</div></div>\`;
      msgs.scrollTop = msgs.scrollHeight;
    } else {
      resultEl.innerHTML = \`<span style="color:var(--red)">Error: \${data.error || 'Unknown error'}</span>\`;
    }
  } catch (e) {
    resultEl.innerHTML = '<span style="color:var(--red)">Failed to submit request</span>';
  }
}

async function loadAccount() {
  try {
    var url = '/api/account';
    if (currentAccountId) url += '?accountId=' + currentAccountId;
    var res = await fetch(url);
    var data = await res.json();
    var label = data.accountName
      ? data.accountName + ' (' + data.accountId + ')'
      : data.accountId + ' (no alias)';
    document.getElementById('accountBadge').textContent = label;
  } catch (e) { }
}

async function loadAgentTimeSeries() {
  try {
    var res = await fetch('/api/agent-timeseries?hours=' + (currentHours || 24) + '&' + regionParam() + accountParam());
    var data = await res.json();
    if (data.error) return;
    renderAgentCharts(data);
  } catch (e) { console.error('agent timeseries error', e); }
}

function renderAgentCharts(data) {
  try {
    // Agent Invocations & Errors
    var invDs = [];
    if (data.agentInvocations && data.agentInvocations.length) invDs.push({ label: 'Invocations', data: data.agentInvocations.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#3b82f6', backgroundColor: '#3b82f620', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
    if (data.agentErrors && data.agentErrors.length) invDs.push({ label: 'Errors', data: data.agentErrors.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#ef4444', backgroundColor: '#ef444420', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
    makeChart('agentInvChart', 'line', { datasets: invDs.length ? invDs : [{ label: 'No data', data: [] }] });

    // Agent Latency Percentiles
    var latDs = [];
    if (data.agentLatencyP50 && data.agentLatencyP50.length) latDs.push({ label: 'p50', data: data.agentLatencyP50.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#22c55e', borderWidth: 1.5, borderDash: [2, 2], tension: .3, pointRadius: 1, fill: false });
    if (data.agentLatencyP90 && data.agentLatencyP90.length) latDs.push({ label: 'p90', data: data.agentLatencyP90.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#eab308', borderWidth: 2, tension: .3, pointRadius: 1, fill: false });
    if (data.agentLatencyP99 && data.agentLatencyP99.length) latDs.push({ label: 'p99', data: data.agentLatencyP99.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#ef4444', borderWidth: 2, borderDash: [6, 3], tension: .3, pointRadius: 1, fill: false });
    if (data.agentLatency && data.agentLatency.length) latDs.push({ label: 'avg', data: data.agentLatency.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#3b82f6', borderWidth: 2, tension: .3, pointRadius: 1, fill: false });
    makeChart('agentLatencyChart', 'line', { datasets: latDs.length ? latDs : [{ label: 'No data', data: [] }] });

    // Agent Step Count
    var stepDs = [];
    if (data.agentStepCount && data.agentStepCount.length) stepDs.push({ label: 'Steps', data: data.agentStepCount.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#8b5cf6', backgroundColor: '#8b5cf620', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
    makeChart('agentStepChart', 'line', { datasets: stepDs.length ? stepDs : [{ label: 'No data', data: [] }] });

    // Knowledge Base Retrieval
    var kbDs = [];
    if (data.kbRetrieveCount && data.kbRetrieveCount.length) kbDs.push({ label: 'Retrievals', data: data.kbRetrieveCount.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#06b6d4', backgroundColor: '#06b6d420', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
    if (data.kbRetrieveLatency && data.kbRetrieveLatency.length) kbDs.push({ label: 'Latency (ms)', data: data.kbRetrieveLatency.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#f97316', borderWidth: 2, tension: .3, pointRadius: 1, fill: false, yAxisID: 'y1' });
    makeChart('kbChart', 'line', { datasets: kbDs.length ? kbDs : [{ label: 'No data', data: [] }] });

    // Guardrail Activity
    var grDs = [];
    if (data.guardrailInvocations && data.guardrailInvocations.length) grDs.push({ label: 'Invocations', data: data.guardrailInvocations.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#3b82f6', backgroundColor: '#3b82f620', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
    if (data.guardrailInterventions && data.guardrailInterventions.length) grDs.push({ label: 'Blocked', data: data.guardrailInterventions.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#ef4444', backgroundColor: '#ef444420', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
    makeChart('guardrailChart', 'line', { datasets: grDs.length ? grDs : [{ label: 'No data', data: [] }] });

    // KB Errors
    var kbErrDs = [];
    if (data.kbErrors && data.kbErrors.length) kbErrDs.push({ label: 'Errors', data: data.kbErrors.map(function(p) { return { x: new Date(p.timestamp), y: p.value }; }), borderColor: '#ef4444', backgroundColor: '#ef444420', fill: true, tension: .3, pointRadius: 2, borderWidth: 2 });
    makeChart('kbErrorChart', 'line', { datasets: kbErrDs.length ? kbErrDs : [{ label: 'No data', data: [] }] });
  } catch (e) { console.error('renderAgentCharts error', e); }
}

async function loadAll() {
  document.getElementById('lastUpdate').textContent = 'Last updated: ' + new Date().toLocaleString();
  if (demoMode) {
    await loadDemoData();
    return;
  }
  await Promise.all([loadQuotas(), loadActiveModels(), loadAgents()]);
  await Promise.all([loadTimeSeries(), loadUsagePie(), loadPredictions(), loadAgentTimeSeries()]);
}

async function loadDemoData() {
  try {
    var res = await fetch('/api/demo-data?hours=' + (currentHours || 24));
    var data = await res.json();

    // Populate summary cards
    document.getElementById('totalInvocations').textContent = data.usage.reduce(function(s, u) { return s + u.invocations; }, 0).toLocaleString();
    document.getElementById('activeModels').textContent = data.activeModels.length;
    document.getElementById('agentInv').textContent = data.agentMetrics.agentInvocations.toLocaleString();
    document.getElementById('kbQueries').textContent = data.agentMetrics.knowledgeBaseQueries.toLocaleString();

    // Quotas
    quotaLimits.invocations = 1000;
    quotaLimits.inputTokens = 500000;
    quotaLimits.outputTokens = 200000;
    var el = document.getElementById('quotasList');
    el.innerHTML = data.quotas.map(function(q) {
      return '<div class="quota-row"><div class="quota-name">✓ ' + q.quotaName + '</div><div class="quota-val">' + q.value.toLocaleString() + ' ' + q.unit + '</div></div>';
    }).join('');

    // Render model charts using existing functions with demo series
    var rawSeries = data.series;
    var series = rawSeries.filter(function(s) { return isModelSelected(s.modelId); });
    renderModelCharts(series);

    // Render agent charts
    renderAgentCharts(data.agentSeries);

    // Pie chart
    var usage = data.usage.filter(function(u) { return isModelSelected(u.modelId); });
    var labels = usage.map(function(u) { return shortName(u.modelId); });
    var values = usage.map(function(u) { return u.invocations; });
    makeChart('pieChart', 'doughnut', {
      labels: labels,
      datasets: [{ data: values, backgroundColor: COLORS.slice(0, labels.length), borderWidth: 0 }],
    }, { plugins: { legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 11 }, padding: 12 } } } });

    // Predictions
    document.getElementById('predictionsList').innerHTML = data.series.map(function(s) {
      var util = s.modelId.includes('sonnet') ? 42.3 : 18.7;
      return '<div class="prediction-card"><div class="pred-header"><span class="pred-model">' + shortName(s.modelId) + '</span><span class="badge badge-ok">OK</span></div><div class="pred-row"><span>Utilization</span><span>' + util + '%</span></div><div class="bar-track"><div class="bar-fill" style="width:' + util + '%;background:var(--accent)"></div></div><div class="pred-rec">✓ Usage within normal limits</div></div>';
    }).join('');
  } catch (e) { console.error('demo error', e); }
}

loadAccount();
loadAccounts();
setView('all');
loadAll();
setInterval(loadAll, 300000);
</script>
</body>
</html>`;
}

const server = createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`🚀 Bedrock AI Analyser running at http://localhost:${PORT}`);
});
