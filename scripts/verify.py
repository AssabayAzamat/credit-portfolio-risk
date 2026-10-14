"""Independent source reconciliation. Python stdlib only; no SQL business logic reused."""
import csv
import json
from collections import defaultdict
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 40
ROOT = Path(__file__).resolve().parents[1]
MONEY = ('portfolio_kzt', 'par30_kzt', 'par90_kzt', 'npl_kzt', 'provisions_kzt')


def empty():
    return {k: Decimal(0) for k in MONEY} | {'loan_count': 0}


def reference():
    with (ROOT / 'data/fx.csv').open(encoding='utf-8-sig', newline='') as file:
        fx = {}
        for r in csv.DictReader(file):
            key = (r['date'], r['currency'])
            value = Decimal(r['rate_kzt'])
            assert key not in fx or fx[key] == value, 'Conflicting FX'
            fx[key] = value
    with (ROOT / 'data/portfolio.csv').open(encoding='utf-8-sig', newline='') as file:
        rows = list(csv.DictReader(file))
    unique = {}
    totals, segments, groups = defaultdict(empty), defaultdict(empty), defaultdict(lambda: Decimal(0))
    quality = defaultdict(lambda: dict(raw_rows=0, unique_rows=0, duplicates_removed=0, written_off_rows=0, active_rows=0))
    for r in rows:
        date = r['report_date']
        quality[date]['raw_rows'] += 1
        key = (date, r['loan_id'])
        assert key not in unique or unique[key] == r, 'Conflicting loan key'
        unique[key] = r
    for r in unique.values():
        date = r['report_date']
        quality[date]['unique_rows'] += 1
        if int(r['written_off']):
            quality[date]['written_off_rows'] += 1
            continue
        quality[date]['active_rows'] += 1
        rate = Decimal(1) if r['currency'] == 'KZT' else fx[(date, r['currency'])]
        balance = Decimal(r['principal_outstanding']) * rate
        days, rest = int(r['days_past_due']), int(r['restructured'])
        # Evaluate the definitions independently, using Decimal and source CSV.
        npl = (days >= 91) or bool(rest)
        provision = Decimal('0.50') if npl else Decimal('0.10') if days >= 31 else Decimal('0.01')
        amounts = dict(portfolio_kzt=balance,
                       par30_kzt=balance if days >= 31 else Decimal(0),
                       par90_kzt=balance if days >= 91 else Decimal(0),
                       npl_kzt=balance if npl else Decimal(0),
                       provisions_kzt=balance * provision)
        for target in [totals[date], segments[(date, 'sector', r['sector'])], segments[(date, 'program', r['program'])]]:
            for field, value in amounts.items():
                target[field] += value
            target['loan_count'] += 1
        groups[(date, r['group_id'])] += balance
    for date, q in quality.items():
        q['duplicates_removed'] = q['raw_rows'] - q['unique_rows']
        ranked = sorted(((group, amount) for (d, group), amount in groups.items() if d == date), key=lambda x: (-x[1], x[0]))
        t = totals[date]
        t['group_count'] = len(ranked)
        t['top10_kzt'] = sum((amount for _, amount in ranked[:10]), Decimal(0))
        for prefix in ('par30', 'par90', 'npl', 'top10'):
            t[prefix + '_ratio'] = t[prefix + '_kzt'] / t['portfolio_kzt']
        t['provision_ratio'] = t['provisions_kzt'] / t['portfolio_kzt']
    return totals, segments, groups, quality


def main():
    sql = json.loads((ROOT / 'validation/sql-results.json').read_text(encoding='utf-8'))
    totals, segments, groups, quality = reference()
    checks = 0

    def compare(actual, expected, label, tol=Decimal('0.000000000000000001')):
        nonlocal checks
        checks += 1
        assert actual is not None and abs(Decimal(str(actual)) - Decimal(expected)) <= tol, (label, actual, str(expected))

    for r in sql['metrics']:
        date = r['report_date']
        for field, expected in totals[date].items():
            compare(r[field], expected, f'{date} {field}', Decimal(0) if field.endswith('_kzt') else Decimal('1e-18'))
        b = totals['2026-09-01']
        for prefix in ('portfolio', 'provisions'):
            compare(r[prefix + '_delta_kzt'], totals[date][prefix + '_kzt'] - b[prefix + '_kzt'], prefix, Decimal(0))
            compare(r[prefix + '_delta_ratio'], totals[date][prefix + '_kzt'] / b[prefix + '_kzt'] - 1, prefix, Decimal('1e-18'))
        for prefix in ('par30', 'par90', 'npl', 'provision', 'top10'):
            compare(r[prefix + '_delta_pp'], 100 * (totals[date][prefix + '_ratio'] - b[prefix + '_ratio']), prefix, Decimal('1e-16'))
    assert len(sql['metrics']) == len(totals)
    assert len(sql['segments']) == len(segments)
    for r in sql['segments']:
        key = (r['report_date'], r['dimension'], r['segment'])
        expected = segments[key]
        for field, value in expected.items():
            compare(r[field], value, str(key) + field, Decimal(0))
        for prefix in ('par30', 'par90', 'npl'):
            compare(r[prefix + '_ratio'], expected[prefix + '_kzt'] / expected['portfolio_kzt'], str(key) + prefix)
        compare(r['portfolio_share'], expected['portfolio_kzt'] / totals[key[0]]['portfolio_kzt'], str(key))
        compare(r['npl_contribution'], expected['npl_kzt'] / totals[key[0]]['portfolio_kzt'], str(key))
    assert len(sql['groups']) == len(groups)
    for r in sql['groups']:
        key = (r['report_date'], r['group_id'])
        compare(r['balance_kzt'], groups[key], str(key), Decimal(0))
        ranked = sorted((g for (d, g) in groups if d == key[0]), key=lambda g: (-groups[(key[0], g)], g))
        assert int(r['group_rank']) == ranked.index(key[1]) + 1
    for r in sql['quality']:
        for field, expected in quality[r['report_date']].items():
            compare(r[field], expected, field, Decimal(0))
    # Segment sums reconcile independently for each dimension, never combined.
    for date in totals:
        for dimension in ('sector', 'program'):
            for field in MONEY:
                assert sum((v[field] for (d, dim, _), v in segments.items() if d == date and dim == dimension), Decimal(0)) == totals[date][field]
    report = {'status': 'PASS', 'method': 'CSV + Python Decimal vs PostgreSQL NUMERIC',
              'numeric_comparisons': checks, 'money_tolerance_kzt': '0', 'ratio_tolerance': '1e-18',
              'postgres_version': sql['version'],
              'totals': {d: {k: str(v) for k, v in t.items()} for d, t in totals.items()},
              'quality': dict(quality)}
    (ROOT / 'validation/reconciliation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
