module.exports = function(grunt) {
  grunt.loadNpmTasks("grunt-webfont");


  grunt.initConfig({
    webfont: {
      icons: {
        src: "./*.svg",
        dest: "../shell/public/icons",
        destCss: "../shell/client",
        options: {
          font: "sandstorm-icons",
          engine: "node",
          autoHint: false,
          htmlDemo: false,
          relativeFontPath: "/icons/",
          stylesheet: "scss",
        },
      },
    },
  });

  grunt.registerTask("default", ["webfont"]);
};
