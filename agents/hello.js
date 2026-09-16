agent.arm = async () => {
  agent.pip("ok");
  const title = document.title || agent.match;
  console.log("[pagearm] armed on", title);
};
