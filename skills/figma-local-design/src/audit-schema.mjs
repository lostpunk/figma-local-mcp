import { z } from 'zod';

const label = z.string().min(1).max(200);
export const auditSchema = {
  nodeId: label,
  maxNodes: z.number().int().min(1).max(10000).default(2000),
  maxFindings: z.number().int().min(1).max(500).default(100),
  tolerance: z.number().finite().min(0).max(10).default(0.5),
  checkTextStyles: z.boolean().default(true),
  maxStyles: z.number().int().min(1).max(2000).default(500),
  rules: z.object({
    spacing: z.array(z.number().finite().min(0).max(1000)).min(1).max(30).optional(),
    componentStates: z.array(z.object({
      nodeId: label.describe('Verified COMPONENT_SET ID inside the audited subtree.'),
      property: label.describe('Exact variant property name, for example State.'),
      required: z.array(label).min(1).max(20),
    }).strict()).max(50).optional(),
  }).strict().default({}),
};
