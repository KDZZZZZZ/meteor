import { configureAssemblyTemplate as configureProjectAssemblyTemplate, type ConfigureAssemblyTemplateInput } from '../templates/project/tools/meteor/assembly-template.ts';
import { loadProject } from './project.ts';

export const configureAssemblyTemplateSchema = {
  target: { type: 'object', additionalProperties: false, required: ['op_id', 'dtype_id'],
    properties: { op_id: { type: 'string' }, dtype_id: { type: 'string' } },
    description: 'Registered operator/dtype target whose assembly template is being configured.' },
  source_path: { type: 'string', description: 'Chief-selected ASC version assembly template path. Relative paths resolve inside the current workspace; absolute paths are copied and frozen.' },
  template_id: { type: 'string', description: 'Optional stable id for the frozen template. Use a new id when intentionally changing template content.' },
  source_label: { type: 'string', description: 'Optional human-readable origin recorded in template metadata, such as a user file or known repository example.' },
} as const;

export async function configureAssemblyTemplate(root: string, input: ConfigureAssemblyTemplateInput): Promise<unknown> {
  const project = loadProject(root, input.target);
  return configureProjectAssemblyTemplate(project, input);
}
