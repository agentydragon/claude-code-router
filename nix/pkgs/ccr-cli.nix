{ lib
, stdenv
, nodejs
, pnpm
, makeWrapper
, claudeCodeRouterSrc ? ../../.
, version ? "unstable"
, pnpmDepsHash ? "sha256-RcnBO6vOfam80HpDorQ06y5wyn2+1Td9lwzmJXJ+lrY="
}:

let
  pnpmDeps = pnpm.fetchDeps {
    pname = "ccr-cli";
    inherit version;
    src = claudeCodeRouterSrc;
    fetcherVersion = 1;
    hash = pnpmDepsHash;
  };

in
stdenv.mkDerivation {
  pname = "ccr-cli";
  inherit version pnpmDeps;
  src = claudeCodeRouterSrc;

  nativeBuildInputs = [
    nodejs
    pnpm.configHook
    makeWrapper
  ];

  buildPhase = ''
    runHook preBuild
    export CCR_SKIP_UI=1
    pnpm run build
    pnpm prune --prod --ignore-scripts
    runHook postBuild
  '';

  installPhase = ''
    mkdir -p $out/bin $out/share/ccr
    cp -r dist $out/share/ccr/dist
    cp -r node_modules $out/share/ccr/node_modules
    makeWrapper ${nodejs}/bin/node $out/bin/ccr \
      --add-flags "$out/share/ccr/dist/cli.js" \
      --set NODE_PATH "$out/share/ccr/node_modules"
  '';

  meta = with lib; {
    description = "Claude Code Router CLI";
    license = licenses.mit;
    platforms = platforms.unix;
    mainProgram = "ccr";
  };
}
