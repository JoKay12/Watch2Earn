import { supabaseAdmin } from './supabase.js';

const MAX_ATTEMPTS = 5;

function automationEnabled() {
  return process.env.PAYOUT_AUTOMATION_ENABLED === 'true' && Boolean(process.env.PAYOUT_API_URL);
}

async function submitToProvider(payout, redemption) {
  if (!automationEnabled()) return { skipped: true };

  const response = await fetch(process.env.PAYOUT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PAYOUT_API_KEY || ''}`,
      'Idempotency-Key': payout.idempotency_key,
    },
    body: JSON.stringify({
      amount: payout.amount,
      currency: payout.currency,
      type: redemption.reward_type,
      destination: redemption.destination,
      reference: payout.idempotency_key,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `Payout provider returned ${response.status}`);
    error.code = body.code || `HTTP_${response.status}`;
    throw error;
  }
  if (!body.id) throw new Error('Payout provider response did not include an id');
  return { providerPayoutId: body.id };
}

export async function processQueuedPayouts(limit = 10) {
  if (!automationEnabled()) return { processed: 0, skipped: true };
  const { data: payouts, error } = await supabaseAdmin
    .from('payouts')
    .select('*, redemption_requests(*)')
    .in('status', ['queued', 'failed'])
    .lt('attempt_count', MAX_ATTEMPTS)
    .order('created_at')
    .limit(limit);
  if (error) throw error;

  let processed = 0;
  for (const payout of payouts || []) {
    const { data: claimed } = await supabaseAdmin
      .from('payouts')
      .update({
        status: 'processing',
        provider: process.env.PAYOUT_PROVIDER || 'http',
        attempt_count: payout.attempt_count + 1,
        submitted_at: new Date().toISOString(),
        failure_code: null,
        failure_message: null,
      })
      .eq('id', payout.id)
      .in('status', ['queued', 'failed'])
      .select('id')
      .maybeSingle();
    if (!claimed) continue;

    try {
      const result = await submitToProvider(payout, payout.redemption_requests);
      await supabaseAdmin.from('payouts').update({
        status: 'succeeded',
        provider_payout_id: result.providerPayoutId,
        completed_at: new Date().toISOString(),
      }).eq('id', payout.id);
      await supabaseAdmin.from('redemption_requests').update({
        status: 'fulfilled',
        resolved_at: new Date().toISOString(),
      }).eq('id', payout.redemption_id).eq('status', 'pending');
    } catch (providerError) {
      await supabaseAdmin.from('payouts').update({
        status: 'failed',
        failure_code: providerError.code || 'PROVIDER_ERROR',
        failure_message: providerError.message.slice(0, 500),
      }).eq('id', payout.id);
    }
    processed++;
  }
  return { processed, skipped: false };
}
