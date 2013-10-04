/* vim: set syntax=javascript ts=8 sts=8 sw=8 noet: */

function
request_id()
{
	return (Math.floor(Math.random() * 0xffffffff).toString(16));
}

module.exports = {
	request_id: request_id
};
