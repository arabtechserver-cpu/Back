async function test() {
  const params = new URLSearchParams();
  params.append("username", "mina15g4y");
  params.append("key", "3AE-27F-14D-104-830-375-6D");
  params.append("action", "placeserverorder");
  params.append("SERVICEID", "179");
  params.append("CUSTOMFIELD", Buffer.from(JSON.stringify({"PlayerID": "my_test_player_id_123"})).toString("base64"));

  const res = await fetch("http://localhost:5000/api/v1", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  console.log(await res.text());
}
test();
