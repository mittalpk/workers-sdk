import { readFileSync } from "node:fs";
import path from "node:path";
import { V4MiniflareOptionsSchema } from "./v4-schema";
import type { RemoteProxyConnectionString } from "../plugins/shared";
import type {
	DevConfig,
	LegacyConfig,
	MiniflareOptions,
	MiniflareWorkerConfig,
	WorkerOptions,
} from "./schema";
import type {
	ParsedV4MiniflareOptions,
	ParsedV4WorkerOptions,
	V4MiniflareOptions,
} from "./v4-schema";

const FALLBACK_COMPATIBILITY_DATE = "2023-07-24";
const kCurrentWorkerSymbol = Symbol.for("miniflare.kCurrentWorker");

type Env = NonNullable<MiniflareWorkerConfig["env"]>;
type Exports = NonNullable<MiniflareWorkerConfig["exports"]>;
type Manifest = NonNullable<MiniflareWorkerConfig["manifest"]>;
type ManifestModule = Manifest["modules"][string];
type ServiceBinding = Extract<Env[string], { type: "worker" }>;

export function convertV4MiniflareOptions(
	options: V4MiniflareOptions
): MiniflareOptions {
	const parsed = V4MiniflareOptionsSchema.parse(options);
	const converted: MiniflareOptions = {
		...convertSharedOptions(parsed),
		workers: getV4Workers(parsed).map((worker, index) =>
			convertWorkerOptions(worker, index)
		),
	};

	return converted;
}

function convertSharedOptions(options: ParsedV4MiniflareOptions) {
	return {
		host: options.host,
		port: options.port,
		https: options.https,
		httpsKey: options.httpsKey,
		httpsCert: options.httpsCert,
		inspectorPort: options.inspectorPort,
		inspectorHost: options.inspectorHost,
		verbose: options.verbose,
		log: options.log,
		handleStructuredLogs: options.handleStructuredLogs,
		unsafeHandleRuntimeRestart: options.unsafeHandleRuntimeRestart,
		handleUncaughtError: options.handleUncaughtError,
		upstream: options.upstream,
		cf: options.cf,
		unsafeDevRegistryPath: options.unsafeDevRegistryPath,
		unsafeHandleDevRegistryUpdate: options.unsafeHandleDevRegistryUpdate,
		unsafeProxySharedSecret: options.unsafeProxySharedSecret,
		unsafeModuleFallbackService: options.unsafeModuleFallbackService,
		unsafeTriggerHandlers: options.unsafeTriggerHandlers,
		unsafeRuntimeEnv: options.unsafeRuntimeEnv,
		unsafeLocalExplorer: options.unsafeLocalExplorer,
		unsafeObservability: options.unsafeObservability,
		unsafeInspectDurableObjects: options.unsafeInspectDurableObjects,
		logRequests: options.logRequests,
		resourcePersistencePath: options.resourcePersistencePath,
		resourceTmpPath: options.resourceTmpPath,
		stripDisablePrettyError: options.stripDisablePrettyError,
		telemetry: options.telemetry,
		publicUrl: options.publicUrl,
		containerEngine: options.containerEngine,
	} satisfies Omit<MiniflareOptions, "workers">;
}

function getV4Workers(
	options: ParsedV4MiniflareOptions
): ParsedV4WorkerOptions[] {
	if ("workers" in options) {
		return options.workers;
	}
	return [options];
}

function convertWorkerOptions(
	worker: ParsedV4WorkerOptions,
	workerIndex: number
): WorkerOptions {
	const env: Env = {};
	const exports: Exports = {};
	const legacy: LegacyConfig = {};
	const dev: DevConfig = {};
	let remoteProxyConnectionString: RemoteProxyConnectionString | undefined;

	const setRemoteProxyConnectionString = (
		value: RemoteProxyConnectionString | undefined
	) => {
		if (remoteProxyConnectionString === undefined) {
			remoteProxyConnectionString = value;
		}
	};
	const isRemote = (value: RemoteProxyConnectionString | undefined) => {
		setRemoteProxyConnectionString(value);
		return value !== undefined;
	};

	let manifest: Manifest | undefined;
	addSourceOptions(worker, workerIndex, legacy, (value) => {
		manifest = value;
	});

	const config: MiniflareWorkerConfig = {
		type: "worker",
		name: worker.name ?? "",
		compatibilityDate: worker.compatibilityDate ?? FALLBACK_COMPATIBILITY_DATE,
		compatibilityFlags: worker.compatibilityFlags,
		manifest,
		env,
		exports,
	};

	for (const route of worker.routes ?? []) {
		config.triggers ??= [];
		config.triggers.push({ type: "fetch", pattern: route });
	}

	addVariableBindings(env, worker.bindings);
	addNamespaceBindings(env, "kv", worker.kvNamespaces, isRemote);
	addNamespaceBindings(env, "d1", worker.d1Databases, isRemote);
	addR2Bindings(env, worker.r2Buckets, isRemote);
	addDurableObjectBindings(env, exports, config.name, worker, isRemote);
	addQueueBindings(
		env,
		config,
		worker.queueProducers,
		worker.queueConsumers,
		isRemote
	);
	addServiceBindings(env, worker.serviceBindings, isRemote);
	addServiceBindingArray(config, worker.tails, false);
	addServiceBindingArray(config, worker.streamingTails, true);
	addProductBindings(env, exports, config, worker, isRemote);

	legacy.wasmBindings = worker.wasmBindings;
	legacy.textBlobBindings = worker.textBlobBindings;
	legacy.dataBlobBindings = worker.dataBlobBindings;
	legacy.sitePath = worker.sitePath;
	legacy.siteInclude = worker.siteInclude;
	legacy.siteExclude = worker.siteExclude;

	dev.cacheAPI = worker.cacheAPI;
	dev.outboundService = convertOutboundService(
		worker.outboundService,
		isRemote
	);
	dev.remoteProxyConnectionString = remoteProxyConnectionString;
	dev.unsafeInspectorProxy = worker.unsafeInspectorProxy;
	dev.unsafeDirectSockets = worker.unsafeDirectSockets;
	dev.unsafeOverrideFetchWorker = worker.unsafeOverrideFetchWorker;
	dev.unsafeEvalBinding = worker.unsafeEvalBinding;
	dev.useModuleFallbackService = worker.unsafeUseModuleFallbackService;
	dev.hasAssetsAndIsVitest = worker.hasAssetsAndIsVitest;
	dev.unsafeEphemeralDurableObjects = worker.unsafeEphemeralDurableObjects;
	dev.stripCfConnectingIp = worker.stripCfConnectingIp;
	dev.zone = worker.zone;

	const options: WorkerOptions = { config };
	if (Object.keys(legacy).length > 0) {
		options.legacy = legacy;
	}
	if (Object.values(dev).some((value) => value !== undefined)) {
		options.dev = dev;
	}
	return options;
}

function addSourceOptions(
	worker: ParsedV4WorkerOptions,
	workerIndex: number,
	legacy: LegacyConfig,
	setManifest: (manifest: Manifest) => void
) {
	if (Array.isArray(worker.modules)) {
		const manifest = createManifestFromModules(
			worker.modules,
			worker.modulesRoot
		);
		setManifest(manifest);
		return;
	}

	const script =
		"script" in worker
			? worker.script
			: "scriptPath" in worker
				? readFileSync(worker.scriptPath, "utf8")
				: undefined;
	if (script === undefined) {
		throw new TypeError("V4 Miniflare workers must define a script.");
	}

	if (worker.modules === true) {
		const mainModule =
			"scriptPath" in worker && worker.scriptPath !== undefined
				? worker.scriptPath
				: `script-${workerIndex}.mjs`;
		setManifest({
			mainModule,
			modules: {
				[mainModule]: { type: "esm", contents: script },
			},
		});
	} else {
		legacy.serviceWorkerScript = script;
	}
}

function createManifestFromModules(
	modules: Extract<ParsedV4WorkerOptions["modules"], unknown[]>,
	modulesRoot: string | undefined
): Manifest {
	const manifestModules: Manifest["modules"] = {};
	let mainModule: string | undefined;

	for (const module of modules) {
		const name = getModuleName(module.path, modulesRoot);
		mainModule ??= name;
		manifestModules[name] = {
			type: convertModuleType(module.type),
			contents: module.contents ?? readModuleContents(module.path, module.type),
		};
	}

	if (mainModule === undefined) {
		throw new TypeError(
			"V4 Miniflare module workers must define at least one module."
		);
	}

	return { mainModule, modules: manifestModules };
}

function getModuleName(modulePath: string, modulesRoot: string | undefined) {
	if (modulesRoot !== undefined && path.isAbsolute(modulePath)) {
		return path
			.relative(modulesRoot, modulePath)
			.split(path.sep)
			.join(path.posix.sep);
	}
	return modulePath.split(path.sep).join(path.posix.sep);
}

function readModuleContents(
	modulePath: string,
	type:
		| "ESModule"
		| "CommonJS"
		| "Text"
		| "Data"
		| "CompiledWasm"
		| "PythonModule"
		| "PythonRequirement"
): ManifestModule["contents"] {
	if (type === "Data" || type === "CompiledWasm") {
		return toUint8Array(readFileSync(modulePath));
	}
	return readFileSync(modulePath, "utf8");
}

function toUint8Array(buffer: Buffer): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(buffer.byteLength);
	copy.set(buffer);
	return copy;
}

function convertModuleType(
	type:
		| "ESModule"
		| "CommonJS"
		| "Text"
		| "Data"
		| "CompiledWasm"
		| "PythonModule"
		| "PythonRequirement"
): ManifestModule["type"] {
	switch (type) {
		case "ESModule":
			return "esm";
		case "CommonJS":
			return "cjs";
		case "Text":
			return "text";
		case "Data":
			return "data";
		case "CompiledWasm":
			return "wasm";
		case "PythonModule":
			return "python";
		case "PythonRequirement":
			return "python-requirement";
	}
}

function addVariableBindings(
	env: Env,
	bindings: ParsedV4WorkerOptions["bindings"]
) {
	for (const [name, value] of Object.entries(bindings ?? {})) {
		env[name] =
			typeof value === "string"
				? { type: "text", value }
				: { type: "json", value };
	}
}

function addNamespaceBindings(
	env: Env,
	type: "kv" | "d1",
	namespaces:
		| ParsedV4WorkerOptions["kvNamespaces"]
		| ParsedV4WorkerOptions["d1Databases"],
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
) {
	if (namespaces === undefined) {
		return;
	}
	if (Array.isArray(namespaces)) {
		for (const name of namespaces) {
			env[name] = { type, id: name };
		}
		return;
	}
	for (const [name, value] of Object.entries(namespaces)) {
		if (typeof value === "string") {
			env[name] = { type, id: value };
		} else {
			env[name] = {
				type,
				id: value.id,
				remote: isRemote(value.remoteProxyConnectionString),
			};
		}
	}
}

function addR2Bindings(
	env: Env,
	buckets: ParsedV4WorkerOptions["r2Buckets"],
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
) {
	if (buckets === undefined) {
		return;
	}
	if (Array.isArray(buckets)) {
		for (const name of buckets) {
			env[name] = { type: "r2", name };
		}
		return;
	}
	for (const [bindingName, bucket] of Object.entries(buckets)) {
		if (typeof bucket === "string") {
			env[bindingName] = { type: "r2", name: bucket };
		} else {
			env[bindingName] = {
				type: "r2",
				name: bucket.id,
				s3Credentials: bucket.s3Credentials,
				remote: isRemote(bucket.remoteProxyConnectionString),
			};
		}
	}
}

function addDurableObjectBindings(
	env: Env,
	exports: Exports,
	workerName: string,
	worker: ParsedV4WorkerOptions,
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
) {
	for (const [bindingName, object] of Object.entries(
		worker.durableObjects ?? {}
	)) {
		const objectOptions =
			typeof object === "string" ? { className: object } : object;
		const targetWorkerName = objectOptions.scriptName ?? workerName;
		env[bindingName] = {
			type: "durable-object",
			workerName: targetWorkerName,
			exportName: objectOptions.className,
		};
		isRemote(objectOptions.remoteProxyConnectionString);

		if (objectOptions.scriptName === undefined) {
			addDurableObjectExport(exports, objectOptions);
		}
	}

	for (const object of worker.additionalUnboundDurableObjects ?? []) {
		addDurableObjectExport(exports, object);
		isRemote(object.remoteProxyConnectionString);
	}
}

function addDurableObjectExport(
	exports: Exports,
	object: Exclude<
		NonNullable<
			ParsedV4WorkerOptions["additionalUnboundDurableObjects"]
		>[number],
		string
	>
) {
	const exported = {
		type: "durable-object",
		storage: object.useSQLite ? "sqlite" : "legacy-kv",
		unsafeUniqueKey: object.unsafeUniqueKey,
		unsafePreventEviction: object.unsafePreventEviction,
		container: object.container,
	};
	exports[object.className] = exported as Exports[string];
}

function addQueueBindings(
	env: Env,
	config: MiniflareWorkerConfig,
	producers: ParsedV4WorkerOptions["queueProducers"],
	consumers: ParsedV4WorkerOptions["queueConsumers"],
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
) {
	if (Array.isArray(producers)) {
		for (const name of producers) {
			env[name] = { type: "queue", name };
		}
	} else {
		for (const [bindingName, producer] of Object.entries(producers ?? {})) {
			if (typeof producer === "string") {
				env[bindingName] = { type: "queue", name: producer };
			} else {
				env[bindingName] = {
					type: "queue",
					name: producer.queueName,
					deliveryDelay: producer.deliveryDelay,
					remote: isRemote(producer.remoteProxyConnectionString),
				};
			}
		}
	}

	if (Array.isArray(consumers)) {
		for (const name of consumers) {
			config.triggers ??= [];
			config.triggers.push({ type: "queue", name });
		}
	} else {
		for (const [name, consumer] of Object.entries(consumers ?? {})) {
			config.triggers ??= [];
			config.triggers.push({
				type: "queue",
				name,
				deadLetterQueue: consumer.deadLetterQueue,
				maxBatchSize: consumer.maxBatchSize,
				maxBatchTimeout: consumer.maxBatchTimeout,
				maxRetries: consumer.maxRetries,
				retryDelay: consumer.retryDelay,
			});
		}
	}
}

function addServiceBindings(
	env: Env,
	serviceBindings: ParsedV4WorkerOptions["serviceBindings"],
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
) {
	for (const [name, binding] of Object.entries(serviceBindings ?? {})) {
		env[name] = convertServiceDesignator(binding, isRemote);
	}
}

function addServiceBindingArray(
	config: MiniflareWorkerConfig,
	bindings: ParsedV4WorkerOptions["tails"],
	streaming: boolean
) {
	for (const binding of bindings ?? []) {
		const converted = convertServiceDesignator(binding, () => false);
		if (
			converted.type === "worker" &&
			typeof converted.workerName === "string"
		) {
			config.tailConsumers ??= [];
			config.tailConsumers.push({
				workerName: converted.workerName,
				entrypoint: converted.exportName,
				props: converted.props,
				streaming,
			});
		}
	}
}

function convertOutboundService(
	binding: ParsedV4WorkerOptions["outboundService"],
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
): DevConfig["outboundService"] {
	if (binding === undefined) {
		return undefined;
	}
	const converted = convertServiceDesignator(binding, isRemote);
	if (converted.type === "fetcher" || converted.type === "node-handler") {
		return converted;
	}
	if (converted.type === "worker" && typeof converted.workerName === "string") {
		return {
			type: "worker",
			workerName: converted.workerName,
			exportName: converted.exportName,
			props: converted.props,
			remote: converted.remote,
		};
	}
	return undefined;
}

function convertServiceDesignator(
	binding: NonNullable<ParsedV4WorkerOptions["outboundService"]>,
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
): Env[string] {
	if (typeof binding === "function") {
		return { type: "fetcher", handler: binding };
	}
	if (typeof binding === "string") {
		return { type: "worker", workerName: binding };
	}
	if (binding === (kCurrentWorkerSymbol as unknown)) {
		return {
			type: "worker",
			workerName: getCurrentWorkerBindingName(),
		};
	}
	if (typeof binding !== "object" || binding === null) {
		return {
			type: "worker",
			workerName: getCurrentWorkerBindingName(),
		};
	}
	if ("name" in binding) {
		return {
			type: "worker",
			workerName: convertWorkerName(binding.name),
			exportName: binding.entrypoint,
			props: binding.props,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	if ("network" in binding) {
		return { type: "network", ...binding.network };
	}
	if ("external" in binding) {
		return { type: "external", ...binding.external };
	}
	if ("disk" in binding) {
		return { type: "disk", ...binding.disk };
	}
	return { type: "node-handler", handler: binding.node };
}

function getCurrentWorkerBindingName(): ServiceBinding["workerName"] {
	return kCurrentWorkerSymbol as unknown as ServiceBinding["workerName"];
}

function convertWorkerName(
	name: string | symbol
): ServiceBinding["workerName"] {
	return typeof name === "string" ? name : getCurrentWorkerBindingName();
}

function addProductBindings(
	env: Env,
	exports: Exports,
	config: MiniflareWorkerConfig,
	worker: ParsedV4WorkerOptions,
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
) {
	for (const binding of worker.unsafeBindings ?? []) {
		env[binding.name] = {
			type: `unsafe:${binding.type}`,
			dev: { plugin: binding.plugin, options: binding.options },
		};
	}
	if (worker.assets !== undefined) {
		configAssets(env, config, worker);
	}
	if (worker.ai !== undefined) {
		env[worker.ai.binding] = {
			type: "ai",
			remote: isRemote(worker.ai.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(worker.agentMemory ?? {})) {
		env[name] = {
			type: "agent-memory",
			namespace: binding.namespace,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(
		worker.aiSearchNamespaces ?? {}
	)) {
		env[name] = {
			type: "ai-search-namespace",
			namespace: binding.namespace ?? name,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(
		worker.aiSearchInstances ?? {}
	)) {
		env[name] = {
			type: "ai-search",
			name: binding.instance_name ?? binding.namespace ?? name,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(worker.websearch ?? {})) {
		env[name] = {
			type: "web-search",
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(
		worker.analyticsEngineDatasets ?? {}
	)) {
		env[name] = { type: "analytics-engine-dataset", name: binding.dataset };
	}
	for (const [name, value] of Object.entries(worker.hyperdrives ?? {})) {
		env[name] = {
			type: "hyperdrive",
			id: name,
			localConnectionString: String(value),
		};
	}
	for (const [name, binding] of Object.entries(worker.ratelimits ?? {})) {
		env[name] = {
			type: "rate-limit",
			namespace: binding.namespace_id,
			simple: binding.simple,
		};
	}
	for (const [name, binding] of Object.entries(worker.pipelines ?? {})) {
		env[name] = {
			type: "pipeline",
			name:
				typeof binding === "string"
					? binding
					: "stream" in binding
						? binding.stream
						: binding.pipeline,
			remote:
				typeof binding === "string"
					? undefined
					: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const binding of worker.email?.send_email ?? []) {
		env[binding.name] = {
			type: "send-email",
			destinationAddress: binding.destination_address,
			allowedDestinationAddresses: binding.allowed_destination_addresses,
			allowedSenderAddresses: binding.allowed_sender_addresses,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(
		worker.secretsStoreSecrets ?? {}
	)) {
		env[name] = {
			type: "secrets-store-secret",
			storeId: binding.store_id,
			secretName: binding.secret_name,
		};
	}
	for (const [name, binding] of Object.entries(worker.vectorize ?? {})) {
		env[name] = {
			type: "vectorize",
			name: binding.index_name,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(
		worker.dispatchNamespaces ?? {}
	)) {
		env[name] = {
			type: "dispatch-namespace",
			namespace: binding.namespace,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(worker.vpcServices ?? {})) {
		env[name] = {
			type: "vpc-service",
			id: binding.service_id,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(worker.vpcNetworks ?? {})) {
		env[name] = {
			type: "vpc-network",
			...("tunnel_id" in binding
				? { tunnelId: binding.tunnel_id }
				: { networkId: binding.network_id }),
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(worker.mtlsCertificates ?? {})) {
		env[name] = {
			type: "mtls-certificate",
			id: binding.certificate_id,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(worker.helloWorld ?? {})) {
		env[name] = { type: "hello-world", enable_timer: binding.enable_timer };
	}
	for (const [name, binding] of Object.entries(worker.flagship ?? {})) {
		env[name] = {
			type: "flagship",
			id: binding.app_id,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const [name, binding] of Object.entries(worker.artifacts ?? {})) {
		env[name] = {
			type: "artifacts",
			namespace: binding.namespace,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
	for (const name of Object.keys(worker.workerLoaders ?? {})) {
		env[name] = { type: "worker-loader" };
	}
	addSingletonBinding(env, worker.browserRendering, "browser", isRemote);
	addSingletonBinding(env, worker.images, "images", isRemote);
	addSingletonBinding(env, worker.stream, "stream", isRemote);
	addSingletonBinding(env, worker.media, "media", isRemote);
	if (worker.versionMetadata !== undefined) {
		env[worker.versionMetadata] = { type: "version-metadata" };
	}
	for (const [bindingName, workflow] of Object.entries(
		worker.workflows ?? {}
	)) {
		const targetWorkerName = workflow.scriptName ?? config.name;
		env[bindingName] = {
			type: "workflow",
			name: workflow.name,
			workerName: targetWorkerName,
			exportName: workflow.className,
			remote: isRemote(workflow.remoteProxyConnectionString),
		};
		if (workflow.scriptName === undefined) {
			exports[workflow.className] = {
				type: "workflow",
				name: workflow.name,
				limits:
					workflow.stepLimit === undefined
						? undefined
						: { steps: workflow.stepLimit },
			};
		}
	}
}

function configAssets(
	env: Env,
	config: MiniflareWorkerConfig,
	worker: ParsedV4WorkerOptions
) {
	const assets = worker.assets;
	if (assets === undefined) {
		return;
	}
	config.assets = { directory: assets.directory };
	if (assets.binding !== undefined) {
		env[assets.binding] = { type: "assets" };
	}
}

function addSingletonBinding<
	T extends "browser" | "images" | "stream" | "media",
>(
	env: Env,
	binding:
		| {
				binding: string;
				remoteProxyConnectionString?: RemoteProxyConnectionString;
		  }
		| undefined,
	type: T,
	isRemote: (value: RemoteProxyConnectionString | undefined) => boolean
) {
	if (binding !== undefined) {
		env[binding.binding] = {
			type,
			remote: isRemote(binding.remoteProxyConnectionString),
		};
	}
}
