import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { OperationalError } from 'n8n-workflow';
import { toJSONSchema, type $ZodType } from 'zod/v4/core';
import { ignoreOverride, zodToJsonSchema } from 'zod-to-json-schema';

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ZOD3_TYPES = new Set([
	'ZodObject',
	'ZodArray',
	'ZodString',
	'ZodNumber',
	'ZodBoolean',
	'ZodNull',
	'ZodEnum',
	'ZodNativeEnum',
	'ZodLiteral',
	'ZodOptional',
	'ZodNullable',
	'ZodDefault',
	'ZodBranded',
	'ZodReadonly',
	'ZodUnion',
	'ZodDiscriminatedUnion',
	'ZodIntersection',
	'ZodTuple',
	'ZodRecord',
	'ZodLazy',
	'ZodEffects',
	'ZodPipeline',
]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function cloneJson(value: unknown, path: string, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'object' || value === null) throw new Error(`Non-JSON value at ${path}`);
	if (ancestors.has(value)) throw new Error(`Recursive schema at ${path}`);
	ancestors.add(value);
	try {
		return Array.isArray(value)
			? value.map((entry, index) => cloneJson(entry, `${path}[${index}]`, ancestors))
			: Object.fromEntries(
					Object.entries(value).map(([key, entry]) => [
						key,
						cloneJson(entry, `${path}.${key}`, ancestors),
					]),
				);
	} finally {
		ancestors.delete(value);
	}
}

function inlineReferences(
	value: unknown,
	root: unknown,
	path = '$',
	visiting = new Set<string>(),
): unknown {
	const schema = record(value);
	if (!schema) return value;
	if ('$ref' in schema) {
		const ref = schema.$ref;
		if (typeof ref !== 'string' || !ref.startsWith('#/'))
			throw new Error(`Only local JSON Schema references are supported at ${path}`);
		if (visiting.has(ref)) throw new Error(`Recursive JSON Schema reference ${ref} at ${path}`);
		let target: unknown = root;
		for (const segment of decodeURIComponent(ref.slice(2)).split('/'))
			target = record(target)?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
		if (!record(target)) throw new Error(`Unresolved JSON Schema reference ${ref} at ${path}`);
		const siblings = Object.keys(schema).filter((key) => key !== '$ref');
		if (siblings.some((key) => !['description', 'title', '$comment'].includes(key)))
			throw new Error(`Schema reference with validation siblings is unsupported at ${path}`);
		const next = new Set(visiting);
		next.add(ref);
		return {
			...record(inlineReferences(target, root, path, next)),
			...Object.fromEntries(siblings.map((key) => [key, schema[key]])),
		};
	}
	const result = { ...schema };
	for (const key of ['properties', 'patternProperties', 'dependentSchemas']) {
		const map = record(schema[key]);
		if (map)
			result[key] = Object.fromEntries(
				Object.entries(map).map(([name, child]) => [
					name,
					inlineReferences(child, root, `${path}.${key}.${name}`, visiting),
				]),
			);
	}
	for (const key of [
		'items',
		'prefixItems',
		'anyOf',
		'oneOf',
		'allOf',
		'not',
		'additionalProperties',
		'additionalItems',
		'if',
		'then',
		'else',
		'contains',
		'propertyNames',
	]) {
		const child = schema[key];
		if (Array.isArray(child))
			result[key] = child.map((item, index) =>
				inlineReferences(item, root, `${path}.${key}[${index}]`, visiting),
			);
		else if (record(child)) result[key] = inlineReferences(child, root, `${path}.${key}`, visiting);
	}
	// Definitions have now been inlined. Leaving them would retain unresolved/recursive refs.
	delete result.$defs;
	delete result.definitions;
	return result;
}

function validateSchema(value: unknown, path: string): Record<string, unknown> {
	const schema = record(value);
	if (!schema) throw new Error(`Expected a JSON Schema object at ${path}`);
	if ('$ref' in schema) throw new Error(`Schema references are not supported at ${path}`);
	if (schema.type === undefined && record(schema.properties)) schema.type = 'object';
	const types = Array.isArray(schema.type) ? schema.type : [schema.type];
	const compositions = ['anyOf', 'oneOf', 'allOf'].filter((key) => key in schema);
	if (
		schema.type !== undefined &&
		(types.length === 0 || types.some((type) => typeof type !== 'string' || !JSON_TYPES.has(type)))
	) {
		throw new Error(`Unsupported JSON Schema type at ${path}`);
	}
	if (
		schema.type === undefined &&
		compositions.length === 0 &&
		!('enum' in schema) &&
		!('const' in schema)
	) {
		throw new Error(`Unconstrained or unrecognized schema at ${path}`);
	}
	for (const key of compositions) {
		const branches = schema[key];
		if (!Array.isArray(branches) || branches.length === 0)
			throw new Error(`Invalid ${key} at ${path}`);
		schema[key] = branches.map((branch, index) =>
			validateSchema(branch, `${path}.${key}[${index}]`),
		);
	}
	for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
		if (!(key in schema)) continue;
		const properties = record(schema[key]);
		if (!properties) throw new Error(`Invalid ${key} at ${path}`);
		schema[key] = Object.fromEntries(
			Object.entries(properties).map(([name, property]) => [
				name,
				validateSchema(property, `${path}.${key}.${name}`),
			]),
		);
	}
	if (
		'required' in schema &&
		(!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string'))
	) {
		throw new Error(`Invalid required arguments at ${path}`);
	}
	if ('items' in schema) {
		schema.items = Array.isArray(schema.items)
			? schema.items.map((item, index) => validateSchema(item, `${path}.items[${index}]`))
			: validateSchema(schema.items, `${path}.items`);
	} else if (types.includes('array')) {
		throw new Error(`Array item schema is missing at ${path}`);
	}
	for (const key of ['additionalProperties', 'additionalItems']) {
		if (!(key in schema) || typeof schema[key] === 'boolean') continue;
		schema[key] = validateSchema(schema[key], `${path}.${key}`);
	}
	if ('not' in schema) schema.not = validateSchema(schema.not, `${path}.not`);
	// Do not invent required arguments: Zod optional/default fields must stay optional.
	if (schema.type === 'object' && compositions.length === 0) schema.properties ??= {};
	return schema;
}

function convertZod3(schema: unknown): unknown {
	return zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
		$refStrategy: 'none',
		effectStrategy: 'input',
		pipeStrategy: 'input',
		override(def, refs, seen, forceResolution) {
			const type = record(def)?.typeName;
			if (typeof type !== 'string' || !ZOD3_TYPES.has(type)) {
				throw new Error(
					`Unsupported Zod 3 type "${String(type)}" at ${refs.currentPath.join('.')}`,
				);
			}
			if (
				seen &&
				!forceResolution &&
				seen.path.length < refs.currentPath.length &&
				seen.path.every((part, index) => part === refs.currentPath[index])
			) {
				throw new Error(`Recursive Zod schema at ${refs.currentPath.join('.')}`);
			}
			return ignoreOverride;
		},
		postProcess(jsonSchema, _def, refs) {
			if (!jsonSchema) throw new Error(`Schema conversion failed at ${refs.currentPath.join('.')}`);
			return jsonSchema;
		},
	});
}

export function getCodexToolParameters(
	inputSchema: unknown,
	toolName: string,
	options: { rootObjectOnly?: boolean } = {},
): Record<string, unknown> {
	try {
		const schema = record(inputSchema);
		let converted = inputSchema;
		if (schema && typeof schema.safeParse === 'function') {
			if (record(schema._zod)?.def) {
				converted = toJSONSchema(inputSchema as $ZodType, {
					io: 'input',
					target: 'draft-7',
					unrepresentable: 'throw',
					cycles: 'throw',
					reused: 'inline',
					override({ zodSchema, jsonSchema }) {
						// Descriptions live in the originating Zod copy's metadata registry.
						const description = record(zodSchema)?.description;
						if (typeof description === 'string') jsonSchema.description = description;
					},
				});
			} else if (typeof record(schema._def)?.typeName === 'string') {
				converted = convertZod3(inputSchema);
			} else {
				throw new Error('Unrecognized Zod schema version');
			}
		} else if (schema && ('_def' in schema || '_zod' in schema)) {
			throw new Error('Invalid Zod schema');
		}
		const cloned = cloneJson(converted, '$');
		const normalized = validateSchema(inlineReferences(cloned, cloned), '$');
		if (
			normalized.type === undefined &&
			['anyOf', 'oneOf', 'allOf'].some(
				(key) =>
					Array.isArray(normalized[key]) &&
					(normalized[key] as Array<Record<string, unknown>>).every(
						(branch) => branch.type === 'object',
					),
			)
		)
			normalized.type = 'object';
		delete normalized.$schema;
		if (normalized.type === 'object') {
			// Closing composed object branches would reject arguments defined by sibling branches.
			if (
				typeof schema?.safeParse === 'function' &&
				!['anyOf', 'oneOf', 'allOf'].some((key) => key in normalized)
			) {
				normalized.additionalProperties ??= false;
			}
			return normalized;
		}
		if (options.rootObjectOnly)
			throw new Error('Native output schemas must describe an object at the root');
		if (typeof normalized.type !== 'string' || !JSON_TYPES.has(normalized.type)) {
			throw new Error(
				'Top-level tool schema must have an explicit object, array, or primitive type',
			);
		}
		// n8n's text tools use primitive schemas; Responses requires object parameters.
		return {
			type: 'object',
			properties: { input: normalized },
			required: ['input'],
			additionalProperties: false,
		};
	} catch (error) {
		// Model schema conversion has no node context; report the tool and failing schema path.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError(
			`Cannot convert input schema for tool "${toolName}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

const STRICT_KEYWORDS = new Set([
	'type',
	'properties',
	'required',
	'additionalProperties',
	'items',
	'anyOf',
	'enum',
	'const',
	'description',
	'title',
	'$comment',
	'minLength',
	'maxLength',
	'pattern',
	'format',
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'multipleOf',
	'minItems',
	'maxItems',
]);

/** Build the native strict subset without making optional fields required or nullable implicitly. */
export function getCodexStrictSchema(input: unknown, name: string): Record<string, unknown> {
	const schema = getCodexToolParameters(input, name, { rootObjectOnly: true });
	try {
		if (schema.type !== 'object' || schema.anyOf)
			throw new Error('The root must be an object without anyOf');
		let propertyCount = 0;
		let enumCount = 0;
		let stringSize = 0;
		function visit(node: Record<string, unknown>, path: string, depth: number): void {
			if (depth > 10) throw new Error(`Schema nesting exceeds 10 levels at ${path}`);
			for (const key of Object.keys(node))
				if (!STRICT_KEYWORDS.has(key))
					throw new Error(`Unsupported strict-schema keyword "${key}" at ${path}`);
			if (
				node.format !== undefined &&
				![
					'date-time',
					'time',
					'date',
					'duration',
					'email',
					'hostname',
					'ipv4',
					'ipv6',
					'uuid',
				].includes(String(node.format))
			)
				throw new Error(`Unsupported native string format "${String(node.format)}" at ${path}`);
			const types = Array.isArray(node.type) ? node.type : [node.type];
			if (types.includes('object')) {
				if (node.additionalProperties !== undefined && node.additionalProperties !== false)
					throw new Error(`Free-form object properties are not supported at ${path}`);
				node.additionalProperties = false;
				const properties = record(node.properties) ?? {};
				const keys = Object.keys(properties);
				const required = Array.isArray(node.required) ? node.required : [];
				if (
					keys.some((key) => !required.includes(key)) ||
					required.some((key) => !keys.includes(String(key))) ||
					new Set(required).size !== required.length
				)
					throw new Error(
						`All properties must be required at ${path}; declare nullable required fields explicitly instead of optional fields`,
					);
				node.properties = properties;
				node.required = required;
				propertyCount += keys.length;
				stringSize += keys.join('').length;
				for (const [key, child] of Object.entries(properties))
					visit(child as Record<string, unknown>, `${path}.properties.${key}`, depth + 1);
			}
			if (node.items) {
				if (Array.isArray(node.items)) throw new Error(`Tuple arrays are not supported at ${path}`);
				visit(node.items as Record<string, unknown>, `${path}.items`, depth + 1);
			}
			if (Array.isArray(node.anyOf))
				node.anyOf.forEach((branch, index) =>
					visit(branch as Record<string, unknown>, `${path}.anyOf[${index}]`, depth),
				);
			if (Array.isArray(node.enum)) {
				enumCount += node.enum.length;
				const size = node.enum.filter((value) => typeof value === 'string').join('').length;
				stringSize += size;
				if (node.enum.length > 250 && size > 15_000)
					throw new Error(`Enum string values exceed 15000 characters at ${path}`);
			}
			if (typeof node.const === 'string') stringSize += node.const.length;
		}
		visit(schema, '$', 1);
		if (propertyCount > 5000 || enumCount > 1000 || stringSize > 120_000)
			throw new Error('Schema exceeds native strict property, enum, or string-size limits');
		getValidator(schema);
		return schema;
	} catch (error) {
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
		throw new OperationalError(
			`Cannot enable native strict output for "${name}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

const schemaValidators = new Map<string, ValidateFunction>();
const validator = addFormats(
	new Ajv({
		strict: false,
		strictNumbers: true,
		allErrors: true,
		ownProperties: true,
		addUsedSchema: false,
	}),
);
function getValidator(schema: Record<string, unknown>): ValidateFunction {
	const key = JSON.stringify(schema);
	let compiled = schemaValidators.get(key);
	if (!compiled) {
		compiled = validator.compile(schema);
		schemaValidators.set(key, compiled);
		if (schemaValidators.size > 64) {
			const oldest = schemaValidators.keys().next().value!;
			validator.removeSchema(schemaValidators.get(oldest)!.schema);
			schemaValidators.delete(oldest);
		}
	}
	return compiled;
}

export function assertCodexSchemaValue(
	value: unknown,
	schema: Record<string, unknown>,
	name: string,
): void {
	const validate = getValidator(schema);
	if (!validate(value)) {
		// Report paths/constraints, never customer values.
		const detail = validate.errors
			?.slice(0, 3)
			.map((error) => `${error.instancePath || '/'} ${error.message}`)
			.join('; ');
		throw new OperationalError(`Codex output does not match strict schema "${name}": ${detail}`);
	}
}
