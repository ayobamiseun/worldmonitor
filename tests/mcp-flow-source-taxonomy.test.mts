/**
 * #6113 — the chokepoint-flows dataset served the raw seeder blob on the MCP
 * surface with no FlowSource taxonomy: not discoverable (the output schema
 * declared bare `additionalProperties: {type:'object'}`) and not narrowed
 * (`toFlowSource` never ran on the cache-tool path), while the REST handler
 * both declared and enforced the closed enum since #6101.
 *
 * Option 1 from the issue — narrow AND declare in the same change, so the
 * declaration and the served bytes move together (the
 * contract-gate-field-names-miss-value-axis defect class): the tool's
 * `_postFilter` narrows `source` onto the taxonomy exactly like the REST
 * boundary does, and the schema declares the enum an agent can discover from
 * `tools/list`. Both sides import one shared taxonomy module, typed
 * exhaustively against the generated `FlowSource`, so a proto change is a
 * compile error in each consumer rather than silent drift.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const tool = CACHE_TOOLS.find((t) => t.name === 'get_chokepoint_status');

/** The wire taxonomy #6101 promoted (generated FlowSource union). */
const WIRE_TAXONOMY = ['FLOW_SOURCE_UNSPECIFIED', 'portwatch-dwt', 'portwatch-counts'];

function flowsData() {
  return {
    'chokepoint-flows': {
      hormuz_strait: {
        currentMbd: 2.6, baselineMbd: 21, flowRatio: 0.123, disrupted: true,
        source: 'portwatch-dwt', hazardAlertLevel: 'RED', hazardAlertName: 'HORMUZ-26',
      },
      suez: {
        currentMbd: 7.6, baselineMbd: 7.6, flowRatio: 1.001, disrupted: false,
        // An undeclared basis a newer seeder deploy could emit — the exact
        // value class the REST boundary narrows and MCP served verbatim.
        source: 'satellite-blend', hazardAlertLevel: null, hazardAlertName: null,
      },
      panama: {
        currentMbd: 1.1, baselineMbd: 1.2, flowRatio: 0.917, disrupted: false,
        source: null, hazardAlertLevel: null, hazardAlertName: null,
      },
    },
  };
}

describe('get_chokepoint_status FlowSource taxonomy (#6113)', () => {
  it('narrows an out-of-taxonomy source to FLOW_SOURCE_UNSPECIFIED and keeps declared values verbatim', () => {
    assert.ok(tool, 'tool must exist in CACHE_TOOLS');
    const data = flowsData();

    tool._postFilter(data, {});

    const flows = data['chokepoint-flows'];
    assert.equal(flows.hormuz_strait.source, 'portwatch-dwt', 'a declared basis passes through untouched');
    assert.equal(
      flows.suez.source, 'FLOW_SOURCE_UNSPECIFIED',
      'an undeclared seeder value must be narrowed, not served verbatim — the schema promise must be kept by the code',
    );
    assert.equal(flows.panama.source, 'FLOW_SOURCE_UNSPECIFIED', 'a missing basis narrows too');
    assert.equal(flows.hormuz_strait.currentMbd, 2.6, 'narrowing must not disturb the numeric fields');
  });

  it('narrows on the filtered path too (chokepoint param applied)', () => {
    const data = flowsData();

    tool._postFilter(data, { chokepoint: 'suez' });

    assert.deepEqual(Object.keys(data['chokepoint-flows']), ['suez']);
    assert.equal(data['chokepoint-flows'].suez.source, 'FLOW_SOURCE_UNSPECIFIED');
  });

  it('leaves an absent or null chokepoint-flows dataset alone', () => {
    const empty = { 'chokepoint-flows': null };
    assert.doesNotThrow(() => tool._postFilter(empty, {}));
    assert.equal(empty['chokepoint-flows'], null);

    const missing = {};
    assert.doesNotThrow(() => tool._postFilter(missing, {}));
  });

  it('declares the closed taxonomy in the output schema an agent discovers', () => {
    const flowsSchema = tool.outputSchema.properties.data.properties['chokepoint-flows'];
    const valueSchema = flowsSchema.additionalProperties;
    assert.equal(valueSchema.type, 'object');
    assert.deepEqual(
      valueSchema.properties.source.enum, WIRE_TAXONOMY,
      'the enum an agent sees from tools/list must be the taxonomy the served bytes are narrowed onto',
    );
    // The declared value shape carries the real flow fields, not a bare
    // object — the coverage fixture stops passing trivially.
    for (const field of ['currentMbd', 'baselineMbd', 'flowRatio', 'disrupted', 'hazardAlertLevel']) {
      assert.ok(valueSchema.properties[field], `schema must declare ${field}`);
    }
  });
});
