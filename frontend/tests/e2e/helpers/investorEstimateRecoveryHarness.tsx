import '../../../src/styles/global.css';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveInvestorTrendEstimate } from '../../../src/api/liveInvestorTrendEstimate';
import { InvestorTrendEstimateCard } from '../../../src/sidebar/InvestorTrendEstimateCard';

function Estimate() {
  const [code, setCode] = useState('005930');
  const query = useLiveInvestorTrendEstimate(code);
  return <><button onClick={() => setCode('000660')}>다른 종목</button>
    <div aria-label={code}><InvestorTrendEstimateCard query={query} /></div></>;
}

export function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  flushSync(() => createRoot(host).render(<QueryClientProvider client={new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })}><Estimate /></QueryClientProvider>));
}
