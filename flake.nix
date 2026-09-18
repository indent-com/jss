{
  description = "QuickJS-NG WebAssembly bindings for Node.js and browsers";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = nixpkgs.lib.genAttrs systems;
      perSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          node = pkgs.nodejs_24;
          manifest = builtins.fromJSON (builtins.readFile ./package.json);
          source = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let name = baseNameOf path; in
              !(builtins.elem name [ "node_modules" "dist" ".git" "result" ".cache" ".direnv" "artifacts" "test-results" "playwright-report" ])
              && !(pkgs.lib.hasPrefix "result-" name)
              && !(pkgs.lib.hasSuffix ".log" name);
          };
          nodeModules = pkgs.importNpmLock.buildNodeModules {
            npmRoot = ./.;
            nodejs = node;
            derivationArgs = {
              npmFlags = [ "--ignore-scripts" ];
              PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            };
          };
          nodeCommand = name: attrs: script: pkgs.runCommand name ({
            nativeBuildInputs = [ node ];
          } // attrs) ''
            export npm_config_cache="$TMPDIR/npm-cache"
            export npm_config_userconfig="$TMPDIR/npmrc"
            touch "$npm_config_userconfig"
            ${script}
          '';
          check = name: attrs: script: nodeCommand "jss-${name}-check" attrs ''
            ${script}
            touch "$out"
          '';
          package = nodeCommand "jss-${manifest.version}" {
            nativeBuildInputs = [ node pkgs.emscripten ];
          } ''
            cp -R ${source}/. .
            chmod -R u+w .
            ln -s ${nodeModules}/node_modules node_modules
            export EM_CACHE="$TMPDIR/emscripten-cache"
            npm run build
            mkdir -p "$out/docs"
            cp -R dist package.json README.md LICENSE THIRD_PARTY_NOTICES.md "$out/"
            cp docs/design.md "$out/docs/"
          '';
          npm = nodeCommand "jss-npm-${manifest.version}" {
            nativeBuildInputs = [ node pkgs.emscripten ];
            JSS_SOURCE_REVISION = self.rev or "";
          } ''
            mkdir -p "$out" work
            cp -R ${package}/. work/
            chmod -R u+w work
            cd work
            node ${./scripts/pack.mjs} "$out"
          '';
          tarball = "${npm}/indent-com-jss-${manifest.version}.tgz";
          runtimeCheck = check "runtime" {} ''
            cp -R ${package}/. .
            cp -R ${source}/test test
            cp -R ${source}/bin bin
            chmod -R u+w bin
            patchShebangs bin
            node --test test/publish.test.mjs
            node test/package.mjs ${tarball}
          '';
          packageCheck = check "package" {} ''
            node ${source}/bin/publish --dry-run --artifact ${tarball}
          '';
          browserCheck = check "browser" {
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            # Firefox's subprocess startup is unsupported in the Nix build sandbox.
            JSS_BROWSERS = "chromium";
          } ''
            cp -R ${package}/. .
            cp -R ${source}/test test
            ln -s ${nodeModules}/node_modules node_modules
            node test/browser.mjs ${tarball}
          '';
          typesCheck = check "consumer-types" {} ''
            mkdir consumer
            printf '{"private":true,"type":"module"}\n' > consumer/package.json
            npm install --prefix consumer --offline --ignore-scripts --no-audit --no-fund ${tarball}
            cp ${source}/test/types.mts consumer/types.mts
            cd consumer
            ${nodeModules}/node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext \
              --typeRoots ${nodeModules}/node_modules/@types types.mts
          '';
          examplesCheck = check "examples" {} ''
            cp -R ${package}/. .
            cp -R ${source}/examples examples
            cp -R ${source}/scripts scripts
            ln -s ${nodeModules}/node_modules node_modules
            node --test examples/runner.test.mjs
          '';
          benchmarkNative = pkgs.runCommand "jss-benchmark-native" {
            nativeBuildInputs = [ pkgs.stdenv.cc ];
          } ''
            mkdir -p "$out/bin"
            cc -std=c11 -O3 -DNDEBUG -D_GNU_SOURCE -DQUICKJS_NG_BUILD -funsigned-char \
              -I${./vendor/quickjs} ${./benchmarks/native.c} \
              ${./vendor/quickjs}/quickjs.c ${./vendor/quickjs}/dtoa.c \
              ${./vendor/quickjs}/libregexp.c ${./vendor/quickjs}/libunicode.c \
              -lm -pthread -o "$out/bin/jss-benchmark-native"
          '';
        in {
          inherit package npm runtimeCheck packageCheck browserCheck typesCheck examplesCheck benchmarkNative;
          shell = pkgs.mkShell ({
            packages = [ node pkgs.emscripten pkgs.typescript pkgs.git pkgs.jq pkgs.curl ];
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            shellHook = ''
              export EM_CACHE="$(pwd)/.cache/emscripten"
              mkdir -p "$EM_CACHE"
            '';
          } // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          });
        };
    in {
      packages = forAll (system: let p = perSystem system; in {
        default = p.package; npm = p.npm; benchmark-native = p.benchmarkNative;
      });
      devShells = forAll (system: { default = (perSystem system).shell; });
      checks = forAll (system: let p = perSystem system; in {
        build = p.package; runtime = p.runtimeCheck; package = p.packageCheck; types = p.typesCheck;
        examples = p.examplesCheck;
      } // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") { browser = p.browserCheck; });
    };
}
