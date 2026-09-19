{
  lib,
  buildNpmPackage,
  nodejs_22,
  fuse,
  sqlite,
  gnupg,
  pkg-config,
  autoPatchelfHook,
  makeWrapper,
  stdenv,
}:

let
  pkg = lib.importJSON ../package.json;
in
buildNpmPackage {
  pname = "proton-drive";
  inherit (pkg) version;

  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: _type:
      let
        base = baseNameOf path;
      in
      !(builtins.elem base [
        "node_modules"
        "dist"
        ".git"
        ".direnv"
        "result"
      ]);
  };

  nodejs = nodejs_22;

  # Hash of the npm dependency tree; refresh with:
  #   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
  npmDepsHash = "sha256-hSsGYG8dDSywI67deJripQ2eeCsoQTUPHZpMbDWmFZM=";

  nativeBuildInputs = [
    pkg-config
    autoPatchelfHook
    makeWrapper
  ];

  buildInputs = [
    fuse
    sqlite
    stdenv.cc.cc.lib
  ];

  # Native addons (fuse-native, better-sqlite3) must compile against the
  # Nix-provided libraries; there is no network in the sandbox, so never
  # try to download prebuilt binaries.
  env.npm_config_build_from_source = "true";

  # `npm run build` (esbuild bundle) is the default npmBuildScript.

  # The credentials store shells out to gpg; put it on PATH so `nix run`
  # doesn't depend on the caller's environment.
  postInstall = ''
    wrapProgram $out/bin/proton-drive --prefix PATH : ${lib.makeBinPath [ gnupg ]}
  '';

  # Typecheck the sources during the build; esbuild only strips types, it does
  # not check them.
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    runHook postCheck
  '';

  meta = {
    description = pkg.description;
    homepage = "https://github.com/rtrusky/protondrive-nemo";
    license = lib.licenses.mit;
    mainProgram = "proton-drive";
    platforms = lib.platforms.linux;
  };
}
