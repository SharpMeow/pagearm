agent.arm = async () => {
  agent.pip("work");
  agent.type(agent.q("#vessel"), "Mackerel Queen");
  agent.type(agent.q("#catch"), "herring");
  agent.type(agent.q("#stone"), "240");
  agent.type(agent.q("#grade"), "A");
  await agent.wait(80);
  agent.punch(agent.q("#save-claim"));
  agent.must("#receipt", "receipt painted");
  const receipt = agent.q("#receipt");
  const ok = receipt && receipt.hidden === false;
  agent.pip(ok ? "ok" : "err", ok ? "saved" : "");
};
