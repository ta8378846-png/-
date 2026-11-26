import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadCivicEngine() {
  const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
  const match = html.match(/<script id="civic-engine-script">([\s\S]*?)<\/script>/);
  assert.ok(match && match[1], 'civic-engine-script block must exist in index.html');

  const sandbox: Record<string, unknown> = {
    Math,
    Date,
    JSON,
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    Object,
    Array,
    Number,
    String,
    Error,
    globalThis: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox);
  return sandbox.CivicEngine as any;
}

const E = loadCivicEngine();

test('initial state is balanced and survives 24 months without collapsing', () => {
  const s = E.createInitialState('测试联邦');
  assert.equal(s.population, 100);
  assert.equal(E.getIdlePopulation(s), 10);

  for (let i = 0; i < 24; i++) {
    E.stepMonth(s, { suppressEvents: true });
  }

  assert.ok(s.treasury > 400, `expected treasury growth, got ${s.treasury}`);
  assert.ok(s.resources > 100, `expected resource stability, got ${s.resources}`);
  assert.ok(s.livelihood >= 60, `expected healthy livelihood >= 60, got ${s.livelihood}`);
  assert.ok(s.civicOps >= 70, `expected healthy civicOps >= 70, got ${s.civicOps}`);
  assert.ok(s.population > 100, `expected natural pop growth, got ${s.population}`);
});

test('worker assignment respects idle cap and zero floor', () => {
  const s = E.createInitialState('测试国');
  assert.equal(E.assignWorkers(s, 'farmers', 10), true);
  assert.equal(s.jobs.farmers, 46);
  assert.equal(E.getIdlePopulation(s), 0);

  assert.equal(E.assignWorkers(s, 'artisans', 1), false);
  assert.equal(E.assignWorkers(s, 'farmers', -100), true);
  assert.equal(s.jobs.farmers, 0);
  assert.equal(E.getIdlePopulation(s), 46);
});

test('resource zero triggers 80% industrial output collapse', () => {
  const s = E.createInitialState('断供国');
  s.jobs.farmers = 0;
  s.jobs.artisans = 30;
  s.resources = 0;

  const rates = E.computeRates(s);
  assert.equal(rates.industryResourceFactor, 0.2);
});

test('civicOps drops below 70% under high population/era load and penalizes output', () => {
  const s = E.createInitialState('过载国');
  s.population = 300;
  s.eraIndex = 2;
  s.jobs.civic = 5;
  s.jobs.medics = 5;
  for (let i = 0; i < 12; i++) {
    E.stepMonth(s, { suppressEvents: true });
  }
  assert.ok(s.civicOps < 70, `expected civicOps < 70, got ${s.civicOps}`);
  const rates = E.computeRates(s);
  assert.ok(rates.opsEfficiencyMult < 1.0);
});

test('laws enforce mutual exclusivity and era gating', () => {
  const s = E.createInitialState('法制国');
  const r1 = E.toggleLaw(s, 'agrarian_first');
  assert.equal(r1.changed, true);
  assert.ok(s.activeLaws.includes('agrarian_first'));

  const r2 = E.toggleLaw(s, 'industry_first');
  assert.equal(r2.changed, true);
  assert.ok(s.activeLaws.includes('industry_first'));
  assert.ok(!s.activeLaws.includes('agrarian_first'));

  const rLocked = E.toggleLaw(s, 'eight_hour');
  assert.equal(rLocked.changed, false);
});

test('tech unlock, era advancement, and Base64 UTF-8 save/load roundtrip', () => {
  const s = E.createInitialState('星海测试国');
  s.researchPoints = 200;
  s.education = 30;
  s.treasury = 500;

  assert.equal(E.unlockTech(s, 'crop_rotation'), true);
  assert.ok(s.unlockedTechs.includes('crop_rotation'));
  assert.equal(E.advanceEra(s), true);
  assert.equal(s.eraIndex, 1);

  const code = E.serializeSave(s);
  const restored = E.deserializeSave(code);
  assert.equal(restored.nationName, '星海测试国');
  assert.equal(restored.eraIndex, 1);
  assert.deepEqual(restored.unlockedTechs, ['crop_rotation']);
});

test('plot building, upgrade, and demolish update city state and rates', () => {
  const s = E.createInitialState('建设国');
  const beforeMil = E.computeRates(s).militaryPower;
  const beforeGold = s.treasury;

  const built = E.buildOnPlot(s, 1, 'fortress');
  assert.equal(built.ok, true);
  assert.equal(s.plots[1].buildingType, 'fortress');
  assert.equal(s.plots[1].level, 1);
  assert.ok(s.treasury < beforeGold);
  assert.ok(E.computeRates(s).militaryPower > beforeMil);

  const up = E.upgradePlot(s, 1);
  assert.equal(up.ok, true);
  assert.equal(s.plots[1].level, 2);

  s.treasury = 5000;
  s.resources = 5000;
  assert.equal(E.upgradePlot(s, 1).ok, true);
  assert.equal(E.upgradePlot(s, 1).ok, false); // capped at Lv.3

  const dem = E.demolishPlot(s, 1);
  assert.equal(dem.ok, true);
  assert.equal(s.plots[1].buildingType, null);
});

test('military posture and rival competition actions update power, rank, and relations', () => {
  const s = E.createInitialState('强军联邦');
  assert.equal(s.rivals.length, 3);
  assert.equal(E.assignWorkers(s, 'soldiers', 10), true);
  const defRates = E.computeRates(s);

  assert.equal(E.setMilitaryPosture(s, 'expedition'), true);
  const expRates = E.computeRates(s);
  assert.ok(expRates.militaryPower > defRates.militaryPower);

  // Trade builds relation and can forge alliance
  const tr1 = E.performRivalAction(s, 'jade', 'trade');
  assert.equal(tr1.ok, true);
  const tr2 = E.performRivalAction(s, 'jade', 'trade');
  assert.equal(tr2.ok, true);
  const jade = s.rivals.find((r: any) => r.id === 'jade');
  assert.equal(jade.allied, true);

  // Skirmish victory against weaker rival yields spoils
  s.jobs.soldiers = 40;
  s.treasury = 500;
  s.resources = 300;
  const sk = E.performRivalAction(s, 'anvil', 'skirmish');
  assert.equal(sk.ok, true);
  assert.equal(sk.victory, true);
  assert.ok(s.treasury > 500);
});

test('diagnoseIssues aggregates multiple simultaneous crises with actionable fixes', () => {
  const s = E.createInitialState('危机诊断国');
  s.resources = 0;
  s.treasury = -120;
  s.civicOps = 25;
  s.livelihood = 24;
  s.culture = 20;
  s.jobs.farmers = 0;
  s.jobs.civic = 1;
  s.jobs.medics = 1;

  const issues = E.diagnoseIssues(s);
  const ids = issues.map((i: any) => i.id);
  assert.ok(ids.includes('resource_crisis'));
  assert.ok(ids.includes('treasury_crisis'));
  assert.ok(ids.includes('civic_overload'));
  assert.ok(ids.includes('livelihood_crisis'));
  assert.ok(ids.includes('culture_burnout'));
  assert.ok(ids.includes('idle_workers'));

  // Critical issues should sort before warning/tip issues
  assert.equal(issues[0].severity, 'critical');

  // Direct quick fix: boost civic budget and assign farmers
  const resIssue = issues.find((i: any) => i.id === 'resource_crisis');
  const farmerFix = resIssue.fixes.find((f: any) => f.id === 'add_farmers');
  assert.equal(farmerFix.disabled, false);
  const applied = E.applyDiagnosticFix(s, farmerFix.action);
  assert.equal(applied.ok, true);
  assert.ok(s.jobs.farmers > 0);
});

test('autoAssignIdle and quick-build helpers streamline operations safely', () => {
  const s = E.createInitialState('便捷操作国');
  const beforeIdle = E.getIdlePopulation(s);
  assert.equal(beforeIdle, 10);

  const auto = E.autoAssignIdle(s);
  assert.equal(auto.assigned, 10);
  assert.equal(E.getIdlePopulation(s), 0);
  assert.equal(E.sumAssigned(s.jobs), s.population);

  const built = E.buildOnFirstEmptyPlot(s, 'farm');
  assert.equal(built.ok, true);
  assert.ok(built.plot);
  assert.equal(s.plots[built.plot.id].buildingType, 'farm');

  const up = E.upgradeLowestPlot(s);
  assert.equal(up.ok, true);
  assert.equal(s.plots[up.plot.id].level, 2);
});

test('stock market trading, dividends, valuation step, and downturn diagnosis work end-to-end', () => {
  const s = E.createInitialState('金融城邦');
  assert.equal(s.stocks.length, 4);
  const initRates = E.computeRates(s);
  assert.equal(initRates.marketIndex, 1000);
  assert.equal(initRates.stockPortfolioValue, 0);

  // Buy 5 shares of INDX
  const goldBefore = s.treasury;
  const buy = E.tradeStock(s, 'indx', 5);
  assert.equal(buy.ok, true);
  const indx = s.stocks.find((x: any) => x.id === 'indx');
  assert.equal(indx.shares, 5);
  assert.ok(s.treasury < goldBefore);
  assert.ok(indx.avgCost > indx.price); // includes 1% stamp fee

  const postBuyRates = E.computeRates(s);
  assert.ok(postBuyRates.stockPortfolioValue > 150);
  assert.ok(postBuyRates.stockMonthlyDividend > 0);
  assert.ok(postBuyRates.totalRevenue > initRates.totalRevenue);

  // Market regulation modes affect upkeep/revenue
  assert.equal(E.setMarketMode(s, 'stimulate'), true);
  assert.equal(E.computeRates(s).marketUpkeep, 12);
  assert.equal(E.setMarketMode(s, 'tighten'), true);
  assert.equal(E.computeRates(s).marketTaxRevenue, 9);

  // Monthly step updates prices and history
  E.stepMonth(s, { suppressEvents: true, stockNoise: 0.4 });
  assert.ok(indx.history.length >= 3);

  // Sell 2 shares and then sellAll
  const goldPreSell = s.treasury;
  assert.equal(E.tradeStock(s, 'indx', -2).ok, true);
  assert.equal(indx.shares, 3);
  assert.ok(s.treasury > goldPreSell);

  assert.equal(E.tradeStock(s, 'indx', 'sellAll').ok, true);
  assert.equal(indx.shares, 0);
  assert.equal(E.tradeStock(s, 'indx', -1).ok, false);

  // Downturn diagnosis triggers when marketIndex < 760
  s.stocks.forEach((st: any) => { st.price = st.basePrice * 0.65; });
  E.setMarketMode(s, 'free');
  const issues = E.diagnoseIssues(s);
  assert.ok(issues.some((i: any) => i.id === 'market_downturn'));
});

test('random events offer rich variety (>=25 types) with reduced trigger frequency and longer cooldowns', () => {
  assert.ok(E.EVENTS.length >= 26, `expected >= 26 event types, got ${E.EVENTS.length}`);
  const ids = new Set(E.EVENTS.map((e: any) => e.id));
  assert.equal(ids.size, E.EVENTS.length);

  // Verify every event's choices apply cleanly without NaN or throwing
  for (const ev of E.EVENTS) {
    assert.ok(ev.choices.length >= 2);
    for (let idx = 0; idx < ev.choices.length; idx++) {
      const testState = E.createInitialState('事件测试');
      testState.eraIndex = 2;
      testState.monthsElapsed = 20;
      const ok = E.resolveEventChoice(testState, ev.id, idx);
      assert.equal(ok, true);
      assert.ok(Number.isFinite(testState.treasury));
      assert.ok(testState.population >= 10);
    }
  }

  // Verify lower frequency: early months (< 8) never trigger even with rng = 0.01
  const s = E.createInitialState('节奏测试');
  for (let m = 0; m < 7; m++) {
    const res = E.stepMonth(s, { rng: 0.01 });
    assert.equal(res.triggeredEvent, null);
  }

  // At month 8, roll = 0.25 (previously triggered under 0.35) no longer triggers under 0.18
  const rHigh = E.stepMonth(s, { rng: 0.25 });
  assert.equal(rHigh.triggeredEvent, null);

  // At month 9, roll = 0.05 triggers an event, then next 13 months do not trigger even at rng = 0.01
  const rFire = E.stepMonth(s, { rng: 0.05 });
  assert.ok(rFire.triggeredEvent, 'expected eligible event at month 9 with low roll');
  for (let m = 0; m < 13; m++) {
    const rCooldown = E.stepMonth(s, { rng: 0.01 });
    assert.equal(rCooldown.triggeredEvent, null);
  }
});
