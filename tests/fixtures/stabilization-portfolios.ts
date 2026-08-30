export interface StabilizationConcernFixture {
  name: string;
  covers: string;
  excludes: string;
  flow: {
    name: string;
    steps: Array<{ path: string; what_happens: string }>;
  };
  core: Array<{ path: string; symbol: string; role: string }>;
  invariant: { rule: string; why: string };
  entry_question: string;
}

export interface StabilizationPortfolioFixture {
  project_type: string;
  languages: string[];
  concerns: StabilizationConcernFixture[];
  rejected: Array<{ candidate: string; why: string }>;
}

export const STABILIZATION_PORTFOLIOS: Record<string, StabilizationPortfolioFixture> = {
  "commander.js": {
    project_type: "JavaScript command-line parsing library",
    languages: ["JavaScript", "TypeScript declarations"],
    concerns: [
      {
        name: "Option and argument semantics",
        covers: "Required, optional, variadic, default, and conflicting option or argument behavior.",
        excludes: "Help layout and executable subcommand resolution.",
        flow: { name: "parse a declared option", steps: [
          { path: "lib/option.js", what_happens: "Declares value arity and option constraints." },
          { path: "lib/argument.js", what_happens: "Applies positional and variadic argument rules." },
        ] },
        core: [
          { path: "lib/option.js", symbol: "Option", role: "Defines option value and conflict semantics." },
          { path: "lib/argument.js", symbol: "Argument", role: "Defines positional and variadic argument semantics." },
        ],
        invariant: { rule: "Only the final command argument may be variadic.", why: "Earlier variadic arguments make later positions ambiguous." },
        entry_question: "Does this change alter value arity, defaults, conflicts, or variadic parsing?",
      },
      {
        name: "Help formatting and output contracts",
        covers: "Help term layout, width calculation, sorting, wrapping, and rendered command help.",
        excludes: "Option coercion and command action dispatch.",
        flow: { name: "render command help", steps: [
          { path: "lib/help.js", what_happens: "Builds ordered terms and descriptions." },
          { path: "tests/help.test.js", what_happens: "Pins the rendered help contract." },
        ] },
        core: [
          { path: "lib/help.js", symbol: "Help", role: "Owns help layout and display-width behavior." },
          { path: "tests/help.test.js", symbol: "help formatting tests", role: "Exercises stable help rendering behavior." },
        ],
        invariant: { rule: "Wrapping uses visible width rather than ANSI byte length.", why: "Colored help otherwise misaligns." },
        entry_question: "Will this change alter help ordering, width, or emitted text?",
      },
    ],
    rejected: [{ candidate: "lib directory", why: "A directory is not a behavioral specialty." }],
  },
  "aqa-tests": {
    project_type: "Cross-JDK system and compatibility test orchestration",
    languages: ["Groovy", "Shell", "Make", "XML"],
    concerns: [
      {
        name: "Jenkins test-job routing and templating",
        covers: "Pipeline parameters, platform routing, job templating, and suite dispatch.",
        excludes: "SDK download mechanics and individual TestKit execution.",
        flow: { name: "route a Jenkins test request", steps: [
          { path: "buildenv/jenkins/testJobTemplate", what_happens: "Declares the test job parameters." },
          { path: "buildenv/jenkins/JenkinsfileBase", what_happens: "Routes the request into platform test stages." },
        ] },
        core: [
          { path: "buildenv/jenkins/testJobTemplate", symbol: "job template", role: "Defines the external Jenkins test-job contract." },
          { path: "buildenv/jenkins/JenkinsfileBase", symbol: "pipeline stages", role: "Owns dispatch and stage ordering." },
        ],
        invariant: { rule: "Every test job supplies a target platform.", why: "Suite selection and SDK resolution depend on it." },
        entry_question: "Which platforms, suites, and Jenkins parameters does this change affect?",
      },
      {
        name: "Test SDK and dependency provisioning",
        covers: "JDK selection, dependency download, workspace layout, and compilation prerequisites.",
        excludes: "Jenkins job creation and downstream result reporting.",
        flow: { name: "provision a test runtime", steps: [
          { path: "get.sh", what_happens: "Selects and downloads the requested SDK and dependencies." },
          { path: "compile.sh", what_happens: "Compiles the test harness against the provisioned runtime." },
        ] },
        core: [
          { path: "get.sh", symbol: "SDK acquisition", role: "Owns reproducible test dependency provisioning." },
          { path: "compile.sh", symbol: "test compilation", role: "Consumes the provisioned SDK and prepares execution." },
        ],
        invariant: { rule: "The TKG test directory exists before compilation.", why: "Compilation otherwise runs without its harness inputs." },
        entry_question: "Does this change alter SDK identity, download location, or compilation inputs?",
      },
    ],
    rejected: [{ candidate: "generated Make output", why: "Generated runtime output is not tracked specialist evidence." }],
  },
  click: {
    project_type: "Python command-line application framework",
    languages: ["Python"],
    concerns: [
      {
        name: "Command dispatch and Context lifecycle",
        covers: "Command invocation, nested contexts, group dispatch, callbacks, and context teardown.",
        excludes: "Token parsing and shell completion protocol generation.",
        flow: { name: "invoke a command in context", steps: [
          { path: "src/click/core.py", what_happens: "Creates and enters the command Context." },
          { path: "src/click/decorators.py", what_happens: "Injects context and object state into callbacks." },
        ] },
        core: [
          { path: "src/click/core.py", symbol: "Command.invoke", role: "Owns dispatch and Context lifetime." },
          { path: "src/click/decorators.py", symbol: "pass_context", role: "Defines callback access to active context." },
        ],
        invariant: { rule: "Result callbacks finish before the Context exits.", why: "Callbacks require active resources and cleanup registration." },
        entry_question: "Does this change affect context nesting, callback ordering, or teardown?",
      },
      {
        name: "Shell completion protocol",
        covers: "Completion instruction parsing and bash, zsh, and fish completion output.",
        excludes: "Normal callback dispatch and help rendering.",
        flow: { name: "complete a shell token", steps: [
          { path: "src/click/shell_completion.py", what_happens: "Parses the shell completion instruction." },
          { path: "tests/test_shell_completion.py", what_happens: "Exercises completion output and escaping." },
        ] },
        core: [
          { path: "src/click/shell_completion.py", symbol: "shell_complete", role: "Owns completion protocol and shell adapters." },
          { path: "tests/test_shell_completion.py", symbol: "completion tests", role: "Pins supported shell output behavior." },
        ],
        invariant: { rule: "Only source and complete instruction kinds are accepted.", why: "Unknown instructions must not execute arbitrary completion behavior." },
        entry_question: "Which shell protocol and escaping rules does this change affect?",
      },
    ],
    rejected: [{ candidate: "prose validation command", why: "Only an exact executable repository command is trusted." }],
  },
  cobra: {
    project_type: "Go command-line application framework",
    languages: ["Go", "Shell"],
    concerns: [
      {
        name: "Command tree traversal and dispatch",
        covers: "Command lookup, parent traversal, hook ordering, and action dispatch.",
        excludes: "Shell completion transport and generated documentation.",
        flow: { name: "resolve and execute a command", steps: [
          { path: "command.go", what_happens: "Finds the matching command and prepares flags and hooks." },
          { path: "args.go", what_happens: "Applies the selected command argument policy." },
        ] },
        core: [
          { path: "command.go", symbol: "Command.execute", role: "Owns traversal, hook ordering, and dispatch." },
          { path: "args.go", symbol: "PositionalArgs", role: "Enforces dispatch-time argument contracts." },
        ],
        invariant: { rule: "Persistent pre-hooks run parent-first and post-hooks leaf-first.", why: "Changing order breaks inherited command setup and cleanup." },
        entry_question: "Does this alter command selection, inherited hooks, or argument policy?",
      },
      {
        name: "Shell completion and ActiveHelp protocol",
        covers: "Hidden completion requests, completion directives, descriptions, and ActiveHelp messages.",
        excludes: "Normal command execution and static help templates.",
        flow: { name: "serve a shell completion request", steps: [
          { path: "completions.go", what_happens: "Dispatches the hidden completion command and emits directives." },
          { path: "active_help.go", what_happens: "Adds shell-specific ActiveHelp messages." },
        ] },
        core: [
          { path: "completions.go", symbol: "getCompletions", role: "Owns the completion request/response protocol." },
          { path: "active_help.go", symbol: "AppendActiveHelp", role: "Owns contextual completion guidance." },
        ],
        invariant: { rule: "Completion output ends with one numeric directive.", why: "Shell adapters parse the final directive line." },
        entry_question: "Will this change candidate ordering, descriptions, or completion directives?",
      },
    ],
    rejected: [{ candidate: "flag package", why: "A package name is not a maintainer-recognizable behavioral specialty." }],
  },
  hono: {
    project_type: "Multi-runtime web framework",
    languages: ["TypeScript", "JavaScript"],
    concerns: [
      {
        name: "Routing and route matching",
        covers: "Route registration, path merging, router selection, matching, and handler dispatch.",
        excludes: "Middleware continuation and request-scoped response construction.",
        flow: { name: "match an incoming request", steps: [
          { path: "src/hono-base.ts", what_happens: "Registers routes and dispatches the incoming method and path." },
          { path: "src/router/reg-exp-router/matcher.ts", what_happens: "Matches the normalized path to handler indexes." },
        ] },
        core: [
          { path: "src/hono-base.ts", symbol: "HonoBase", role: "Owns route registration and dispatch." },
          { path: "src/router/reg-exp-router/matcher.ts", symbol: "match", role: "Owns regular-expression route matching." },
        ],
        invariant: { rule: "HEAD dispatches through GET while returning a null body.", why: "Headers must match GET without emitting content." },
        entry_question: "Does this change path normalization, router selection, or method dispatch?",
      },
      {
        name: "Middleware composition and execution",
        covers: "Middleware ordering, next propagation, error propagation, and finalized responses.",
        excludes: "Route matching algorithms and concrete middleware policy behavior.",
        flow: { name: "execute a middleware chain", steps: [
          { path: "src/compose.ts", what_happens: "Runs middleware in order and wires next calls." },
          { path: "src/compose.test.ts", what_happens: "Pins single-use next, error propagation, and response finalization." },
        ] },
        core: [
          { path: "src/compose.ts", symbol: "compose", role: "Owns middleware continuation and error propagation." },
          { path: "src/compose.test.ts", symbol: "compose tests", role: "Owns continuation and error propagation regression coverage." },
        ],
        invariant: { rule: "Every chain either returns a Response or calls next.", why: "Otherwise the request remains unfinalized." },
        entry_question: "Does this alter middleware order, next semantics, or response finalization?",
      },
      {
        name: "Request context and response lifecycle",
        covers: "Lazy request body access, per-request variables, response construction, and finalization state.",
        excludes: "Routing algorithms, middleware continuation order, and individual authentication or response-header policies.",
        flow: { name: "construct a response from request state", steps: [
          { path: "src/request.ts", what_happens: "Exposes lazy request access and caches consumed body representations." },
          { path: "src/context.ts", what_happens: "Constructs a Response using pending headers and request-scoped state, then records finalization." },
        ] },
        core: [
          { path: "src/request.ts", symbol: "HonoRequest", role: "Owns request access and body caching semantics." },
          { path: "src/context.ts", symbol: "Context", role: "Owns request-scoped variables and Response finalization." },
        ],
        invariant: { rule: "Assigning the response finalizes the Context while preserving pending headers.", why: "Handlers depend on consistent response state after middleware returns." },
        entry_question: "Does this change body consumption, per-request state, headers, or finalization?",
      },
    ],
    rejected: [
      { candidate: "utils", why: "Utility folders support concerns but are not specialists themselves." },
      { candidate: "Built-in middleware library (auth, security, transport)", why: "A catalog joined by the middleware API combines independent JWT, CSRF, CORS, and security-header invariants rather than one body of knowledge." },
    ],
  },
  gin: {
    project_type: "Go HTTP web framework",
    languages: ["Go"],
    concerns: [
      {
        name: "Radix-tree HTTP route matching",
        covers: "Route insertion, parameter extraction, redirects, method lookup, and handler selection.",
        excludes: "Middleware execution and request binding.",
        flow: { name: "dispatch a matched route", steps: [
          { path: "tree.go", what_happens: "Matches the request path and extracts route parameters." },
          { path: "gin.go", what_happens: "Assigns the matched handler chain to the Context." },
        ] },
        core: [
          { path: "tree.go", symbol: "node.getValue", role: "Owns radix path matching and parameter extraction." },
          { path: "gin.go", symbol: "Engine.handleHTTPRequest", role: "Connects matches to handler execution." },
        ],
        invariant: { rule: "Each HTTP method has exactly one radix root.", why: "Method isolation and lookup depend on separate trees." },
        entry_question: "Does this change path matching, parameters, redirects, or method isolation?",
      },
      {
        name: "Request binding and struct-tag validation",
        covers: "Content-type binding, form mapping, JSON decoding, validation, and binding errors.",
        excludes: "Response rendering and route parameter matching.",
        flow: { name: "bind and validate a request", steps: [
          { path: "binding/binding.go", what_happens: "Chooses a binder from method and content type." },
          { path: "binding/default_validator.go", what_happens: "Validates the populated struct using binding tags." },
        ] },
        core: [
          { path: "binding/binding.go", symbol: "Default", role: "Owns binder selection and request decoding entry." },
          { path: "binding/default_validator.go", symbol: "defaultValidator", role: "Owns struct validation semantics." },
        ],
        invariant: { rule: "The validator tag key is binding.", why: "Changing it silently bypasses repository validation annotations." },
        entry_question: "Which content types, mapping rules, and validation tags are affected?",
      },
      {
        name: "Response rendering and content negotiation",
        covers: "Renderer selection, content types, body encoding, and response writer behavior.",
        excludes: "Request binding and route selection.",
        flow: { name: "render a response", steps: [
          { path: "render/render.go", what_happens: "Applies content type and invokes the selected renderer." },
          { path: "response_writer.go", what_happens: "Commits headers, status, and encoded body bytes." },
        ] },
        core: [
          { path: "render/render.go", symbol: "Render", role: "Defines the rendering contract and content-type write." },
          { path: "response_writer.go", symbol: "responseWriter", role: "Owns committed HTTP response state." },
        ],
        invariant: { rule: "Content-Type is set before body bytes and never overwrites an explicit value.", why: "Late mutation produces invalid HTTP responses." },
        entry_question: "Does this alter renderer selection, content type, status, or body encoding?",
      },
    ],
    rejected: [{ candidate: "render directory", why: "The concern is response behavior, not the directory containing adapters." }],
  },
  axum: {
    project_type: "Rust workspace web framework",
    languages: ["Rust"],
    concerns: [
      {
        name: "Request routing and route composition",
        covers: "Path registration, nesting, method routing, fallback behavior, and route service dispatch.",
        excludes: "Extractor mechanics and middleware implementation.",
        flow: { name: "route a request", steps: [
          { path: "axum/src/routing/mod.rs", what_happens: "Registers and composes path and method routes." },
          { path: "axum/src/routing/route.rs", what_happens: "Polls the selected route service into a response." },
        ] },
        core: [
          { path: "axum/src/routing/mod.rs", symbol: "Router", role: "Owns route composition and nesting." },
          { path: "axum/src/routing/route.rs", symbol: "Route", role: "Owns selected route service execution." },
        ],
        invariant: { rule: "Registered paths begin with a slash.", why: "Path composition and matching assume canonical absolute routes." },
        entry_question: "Does this affect nesting, fallback, path syntax, or method routing?",
      },
      {
        name: "Request extraction and rejection contracts",
        covers: "Parts-first extraction, body extraction, tuple ordering, and rejection conversion.",
        excludes: "Router selection and response encoding after successful extraction.",
        flow: { name: "extract handler arguments", steps: [
          { path: "axum-core/src/extract/mod.rs", what_happens: "Defines parts and body extractor contracts." },
          { path: "axum-core/src/extract/rejection.rs", what_happens: "Converts extraction failures into typed rejections." },
        ] },
        core: [
          { path: "axum-core/src/extract/mod.rs", symbol: "FromRequest", role: "Owns extractor ordering and body-consumption contracts." },
          { path: "axum-core/src/extract/rejection.rs", symbol: "rejections", role: "Owns public extraction failure behavior." },
        ],
        invariant: { rule: "Parts extractors run before the single body extractor.", why: "The request body can only be consumed once." },
        entry_question: "Does this consume the body, alter rejection types, or reorder extraction?",
      },
      {
        name: "Procedural macro derives and diagnostics",
        covers: "FromRequest derives, debug handler attributes, generated bounds, and compile diagnostics.",
        excludes: "Runtime extractor and handler execution.",
        flow: { name: "derive an extractor", steps: [
          { path: "axum-macros/src/lib.rs", what_happens: "Receives the derive invocation and parses attributes." },
          { path: "axum-macros/src/from_request/mod.rs", what_happens: "Generates extractor implementations and diagnostics." },
        ] },
        core: [
          { path: "axum-macros/src/lib.rs", symbol: "derive_from_request", role: "Owns public procedural macro entry points." },
          { path: "axum-macros/src/from_request/mod.rs", symbol: "expand", role: "Owns generated extractor code and errors." },
        ],
        invariant: { rule: "Debug attributes are identity operations outside debug assertions.", why: "Release builds must not carry diagnostic-only behavior." },
        entry_question: "Will generated bounds, attributes, or compile-fail diagnostics change?",
      },
    ],
    rejected: [{ candidate: "workspace crate", why: "A crate boundary is not automatically a behavioral specialty." }],
  },
  "spring-petclinic": {
    project_type: "Spring Boot veterinary clinic application",
    languages: ["Java", "HTML", "SQL"],
    concerns: [
      {
        name: "Owner, pet, and visit lifecycle",
        covers: "Owner lookup and editing plus nested pet and visit form binding and validation.",
        excludes: "Database profile configuration and vet directory caching.",
        flow: { name: "record a pet visit", steps: [
          { path: "src/main/java/org/springframework/samples/petclinic/owner/PetController.java", what_happens: "Binds and validates the pet nested under its owner." },
          { path: "src/main/java/org/springframework/samples/petclinic/owner/VisitController.java", what_happens: "Creates and persists a visit for that pet." },
        ] },
        core: [
          { path: "src/main/java/org/springframework/samples/petclinic/owner/PetController.java", symbol: "PetController", role: "Owns nested pet form lifecycle and validation." },
          { path: "src/main/java/org/springframework/samples/petclinic/owner/VisitController.java", symbol: "VisitController", role: "Owns nested visit form lifecycle." },
        ],
        invariant: { rule: "Form binding cannot set entity identifiers.", why: "Clients must not re-parent or overwrite persistent entities." },
        entry_question: "Does this change owner nesting, binding exclusions, or validation order?",
      },
      {
        name: "Profile-switched database operation",
        covers: "H2, MySQL, and PostgreSQL profiles, schema selection, and integration verification.",
        excludes: "Controller behavior and JPA entity semantics independent of the selected database.",
        flow: { name: "start against a selected database", steps: [
          { path: "src/main/resources/application-mysql.properties", what_happens: "Selects MySQL connection and initialization resources." },
          { path: "src/main/resources/db/mysql/schema.sql", what_happens: "Creates the schema expected by the application." },
        ] },
        core: [
          { path: "src/main/resources/application-mysql.properties", symbol: "mysql profile", role: "Owns MySQL runtime and initialization selection." },
          { path: "src/main/resources/db/mysql/schema.sql", symbol: "clinic schema", role: "Owns MySQL schema compatibility." },
        ],
        invariant: { rule: "Each profile points to schema and data resources for the same engine.", why: "Cross-engine SQL selection fails at startup." },
        entry_question: "Which database profiles and schema variants must remain equivalent?",
      },
    ],
    rejected: [{ candidate: "controller layer", why: "A framework layer combines unrelated owner, vet, and system behaviors." }],
  },
};
