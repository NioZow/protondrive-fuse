{
  pkgs,
  lib ? pkgs.lib,
}:

pkgs.mkShell {
  packages = with pkgs; [
    nodejs_22
    pkg-config
    python3
    gnumake
    gcc
    fuse
    sqlite
    gnupg
  ];

  shellHook = ''
    export PKG_CONFIG_PATH="${
      lib.makeSearchPath "lib/pkgconfig" [
        pkgs.fuse.dev
        pkgs.sqlite.dev
      ]
    }:''${PKG_CONFIG_PATH:-}"

    export LD_LIBRARY_PATH="${
      lib.makeLibraryPath [
        pkgs.fuse
        pkgs.sqlite
        pkgs.stdenv.cc.cc.lib
      ]
    }:''${LD_LIBRARY_PATH:-}"

    echo "proton-drive dev shell"
    echo "  node: $(node --version)  npm: $(npm --version)"
    echo "  build: npm ci && npm run build"
    echo "  run:   node dist/cli.js login && node dist/cli.js mount"
  '';
}
